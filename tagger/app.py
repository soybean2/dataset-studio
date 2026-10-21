"""
Dataset Studio tagging sidecar.

FastAPI service producing booru-style tags + a caption for uploaded images
using LOCAL models only (WD Tagger via transformers, or BLIP captioning),
with a dependency-light deterministic "stub" mode for development.

torch / transformers are imported ONLY inside functions, so this module
runs with just the base deps (fastapi, uvicorn, pillow, numpy,
python-multipart) installed.

Endpoints (fixed contract -- do not change):
  GET  /health   -> {"status","mode","model","device","ready","loaded"}
  POST /tag      -> multipart "files" (repeatable) + optional
                    threshold / max_tags / mode / caption
                    -> {"results":[{"id","tags","caption","error"}]}
  POST /warmup   -> eagerly loads the model, returns /health shape
"""

import csv
import hashlib
import io
import logging
import os
import random
import sys
import threading
import time
from contextlib import asynccontextmanager
from importlib import util as importlib_util
from pathlib import PurePath

import numpy as np
from fastapi import FastAPI, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from starlette.datastructures import UploadFile as StarletteUploadFile

# --------------------------------------------------------------------------
# Logging (stderr, timestamped)
# --------------------------------------------------------------------------
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] tagger: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("tagger")

# --------------------------------------------------------------------------
# Env configuration
# --------------------------------------------------------------------------


def _env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env_str(name, str(default)))
    except ValueError:
        log.warning("invalid %s, falling back to %s", name, default)
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env_str(name, str(default)))
    except ValueError:
        log.warning("invalid %s, falling back to %s", name, default)
        return default


CFG = {
    "HOST": _env_str("HOST", "0.0.0.0"),
    "PORT": _env_int("PORT", 8790),
    "MODE": _env_str("MODE", "auto").lower(),
    "WD_MODEL": _env_str("WD_MODEL", "SmilingWolf/wd-vit-tagger-v3"),
    "BLIP_MODEL": _env_str("BLIP_MODEL", "Salesforce/blip-image-captioning-base"),
    "DEVICE": _env_str("DEVICE", "auto").lower(),
    "THRESHOLD": _env_float("THRESHOLD", 0.35),
    "MAX_TAGS": _env_int("MAX_TAGS", 30),
    "MAX_SIDE": _env_int("MAX_SIDE", 1024),
    "DROP_RATING": _env_int("DROP_RATING", 1),
    "EAGER": _env_int("EAGER", 0),
    "MAX_CONCURRENCY": max(1, _env_int("MAX_CONCURRENCY", 1)),
    "MAX_UPLOAD_MB": _env_float("MAX_UPLOAD_MB", 40),
}

VALID_MODES = ("stub", "wd", "blip")


def _ml_available() -> bool:
    """Cheap check: are torch AND transformers importable? (no import side effects)"""
    return (
        importlib_util.find_spec("torch") is not None
        and importlib_util.find_spec("transformers") is not None
    )


def _resolve_mode(mode: str) -> str:
    if mode != "auto":
        return mode
    return "wd" if _ml_available() else "stub"


EFFECTIVE_MODE = _resolve_mode(CFG["MODE"])

MODEL_ID = {
    "stub": "stub",
    "wd": CFG["WD_MODEL"],
    "blip": CFG["BLIP_MODEL"],
}

# --------------------------------------------------------------------------
# Model state (lazy, lock-guarded)
# --------------------------------------------------------------------------
_models: dict = {}          # mode -> loaded model bundle
_load_lock = threading.Lock()
_infer_semaphore = threading.Semaphore(CFG["MAX_CONCURRENCY"])
_device_cache: dict = {"device": None}


def _resolve_device() -> str:
    """cpu | cuda (only called when ML deps are present)."""
    if CFG["DEVICE"] != "auto":
        return CFG["DEVICE"]
    import torch  # local import on purpose

    return "cuda" if torch.cuda.is_available() else "cpu"


def _current_device_str() -> str:
    if EFFECTIVE_MODE == "stub":
        return "n/a"
    if not _ml_available():
        return "n/a"
    if _device_cache["device"] is None:
        try:
            _device_cache["device"] = _resolve_device()
        except Exception:  # pragma: no cover - defensive
            _device_cache["device"] = "cpu"
    return _device_cache["device"]


def _is_loaded(mode: str) -> bool:
    return mode in _models


def _ensure_loaded(mode: str) -> None:
    """Load model weights for `mode` exactly once, thread-safe. Raises on failure."""
    if mode == "stub":
        return
    if mode in _models:
        return
    with _load_lock:
        if mode in _models:
            return
        t0 = time.time()
        log.info("loading model for mode=%s ...", mode)
        if mode == "wd":
            _models["wd"] = _load_wd()
        elif mode == "blip":
            _models["blip"] = _load_blip()
        else:
            raise ValueError(f"unknown mode: {mode}")
        _device_cache["device"] = _resolve_device()
        log.info("model loaded in %.1fs (device=%s)", time.time() - t0,
                 _device_cache["device"])


def _load_wd() -> dict:
    """Load WD tagger + its label list (selected_tags.csv from the model repo)."""
    import torch
    from huggingface_hub import hf_hub_download
    from transformers import AutoModelForImageClassification

    device = _resolve_device()
    model = AutoModelForImageClassification.from_pretrained(
        CFG["WD_MODEL"], trust_remote_code=True
    )
    model.to(device).eval()

    labels_path = hf_hub_download(repo_id=CFG["WD_MODEL"], filename="selected_tags.csv")
    labels = []  # list of (name, category:int)
    with open(labels_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                cat = int(row.get("category") or 0)
            except ValueError:
                cat = 0
            labels.append((row["name"], cat))
    log.info("wd tagger: %d labels from selected_tags.csv", len(labels))
    return {"model": model, "labels": labels, "torch": torch, "device": device}


def _load_blip() -> dict:
    from transformers import pipeline

    device = _resolve_device()
    pipe = pipeline(
        "image-captioning",
        model=CFG["BLIP_MODEL"],
        device=0 if device == "cuda" else -1,
    )
    return {"pipe": pipe, "device": device}


# --------------------------------------------------------------------------
# Image preprocessing
# --------------------------------------------------------------------------


def _decode_rgb(data: bytes) -> Image.Image:
    """Open bytes with Pillow, EXIF-orient, convert any mode to RGB."""
    img = Image.open(io.BytesIO(data))
    img.load()  # force full decode -> corrupt files raise here
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        # handles RGBA/LA/P/CMYK/16-bit etc.
        img = img.convert("RGB")
    return img


def _downscale_max_side(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest > max_side > 0:
        scale = max_side / float(longest)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                         Image.LANCZOS)
    return img


def _preprocess_wd(img: Image.Image) -> np.ndarray:
    """
    Standard wd-tagger recipe: resize shorter side to 448, center-pad to
    448x448 with black, BGR channel order, float32, normalized.
    Returns HWC float32 numpy array.
    """
    target = 448
    w, h = img.size
    scale = target / min(w, h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    img = img.resize((nw, nh), Image.LANCZOS)

    canvas = Image.new("RGB", (target, target), (0, 0, 0))
    dx = (target - nw) // 2
    dy = (target - nh) // 2
    # crop if resize produced dims larger than target (rounding)
    if nw > target:
        img = img.crop((dx * -1, 0, dx * -1 + target, nh))
        nw, dx = target, 0
    if nh > target:
        img = img.crop((0, dy * -1, nw, dy * -1 + target))
        nh, dy = target, 0
    canvas.paste(img, (dx, dy))

    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    arr = arr[:, :, ::-1]  # RGB -> BGR
    mean = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
    std = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
    return (arr - mean) / std


# --------------------------------------------------------------------------
# Stub mode
# --------------------------------------------------------------------------

STUB_VOCAB = [
    "1girl", "1boy", "solo", "long_hair", "short_hair", "blue_eyes",
    "red_eyes", "smile", "open_mouth", "hat", "ribbon", "glasses",
    "jacket", "dress", "skirt", "shirt", "gloves", "boots", "weapon",
    "sword", "wings", "tail", "animal_ears", "outdoors", "sky", "cloud",
    "tree", "water", "night", "sunset", "city", "cityscape", "building",
    "flower", "rose", "depth_of_field", "blurry_background", "looking_at_viewer",
    "cowboy_shot", "upper_body", "full_body", "portrait", "masterpiece",
    "highres", "detailed_background",
]


def _stub_infer(data: bytes, img: Image.Image, threshold: float = 0.0,
                max_tags: int = 12) -> tuple:
    """Deterministic pseudo-tags from sha256(bytes). Returns (tags, caption)."""
    digest = hashlib.sha256(data).digest()
    rng = random.Random(int.from_bytes(digest[:8], "big"))
    n_tags = 5 + digest[8] % 8  # 5..12
    names = rng.sample(STUB_VOCAB, n_tags)
    scores = sorted(
        (rng.uniform(0.30, 0.99) for _ in range(n_tags)), reverse=True
    )
    pairs = [(nm, sc) for nm, sc in zip(names, scores) if sc >= threshold]
    pairs = pairs[:max_tags]
    tags = [{"name": nm, "score": round(sc, 4)} for nm, sc in pairs]
    w, h = img.size
    caption = "stub %dx%d: %s" % (w, h, ", ".join(nm for nm, _ in pairs[:4]))
    return tags, caption


# --------------------------------------------------------------------------
# Real inference
# --------------------------------------------------------------------------


def _wd_infer(img: Image.Image, threshold: float, max_tags: int,
              drop_rating: bool) -> tuple:
    bundle = _models["wd"]
    torch = bundle["torch"]
    model, labels, device = bundle["model"], bundle["labels"], bundle["device"]

    arr = _preprocess_wd(img)  # HWC BGR float32
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)
    with torch.no_grad():
        logits = model(tensor).logits[0]
    probs = torch.sigmoid(logits).float().cpu().numpy()

    scored = []
    for (name, category), p in zip(labels, probs):
        if category not in (0, 4):  # keep general + character only
            continue
        if drop_rating and name.startswith("rating:"):
            continue
        if p >= threshold:
            scored.append((name.replace("_", " "), float(p)))
    scored.sort(key=lambda t: t[1], reverse=True)
    scored = scored[:max_tags]
    tags = [{"name": nm, "score": round(p, 4)} for nm, p in scored]
    caption = ", ".join(nm for nm, _ in scored)
    return tags, caption


def _blip_infer(img: Image.Image, max_tags: int) -> tuple:
    pipe = _models["blip"]["pipe"]
    out = pipe(img)
    caption = out[0]["generated_text"].strip()
    seen, tokens = set(), []
    for word in caption.lower().replace(",", " ").replace(".", " ").split():
        w = "".join(ch for ch in word if ch.isalpha())
        if w and w not in seen:
            seen.add(w)
            tokens.append(w)
    tags = [{"name": w, "score": 1.0} for w in tokens[:max_tags]]
    return tags, caption


# --------------------------------------------------------------------------
# Batch processing (runs in threadpool; semaphore caps concurrent inference)
# --------------------------------------------------------------------------


def _process_batch(items: list, opts: dict) -> list:
    """items: list of (id, bytes). Returns one result entry per item, in order."""
    mode = opts["mode"]
    threshold = opts["threshold"]
    max_tags = opts["max_tags"]
    want_caption = opts["caption"]
    max_bytes = int(CFG["MAX_UPLOAD_MB"] * 1024 * 1024)
    drop_rating = bool(CFG["DROP_RATING"])

    if mode != "stub":
        _ensure_loaded(mode)  # raises -> caller turns into per-image errors

    results = []
    for image_id, data in items:
        entry = {"id": image_id, "tags": [], "caption": "", "error": None}
        try:
            if len(data) > max_bytes:
                raise ValueError(
                    "file exceeds MAX_UPLOAD_MB (%s MB)" % CFG["MAX_UPLOAD_MB"]
                )
            img = _decode_rgb(data)
            img = _downscale_max_side(img, CFG["MAX_SIDE"])

            with _infer_semaphore:
                if mode == "stub":
                    tags, caption = _stub_infer(data, img, threshold, max_tags)
                elif mode == "wd":
                    tags, caption = _wd_infer(img, threshold, max_tags, drop_rating)
                elif mode == "blip":
                    tags, caption = _blip_infer(img, max_tags)
                else:
                    raise ValueError("unknown mode: %s" % mode)

            entry["tags"] = tags
            entry["caption"] = caption if want_caption else ""
        except Exception as exc:  # per-image failure must not fail the batch
            log.warning("image %s failed: %s", image_id, exc)
            entry["error"] = "%s: %s" % (type(exc).__name__, exc)
            entry["tags"] = []
            entry["caption"] = ""
        results.append(entry)
    return results


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------


def _health_payload() -> dict:
    ml_ok = EFFECTIVE_MODE == "stub" or _ml_available()
    return {
        "status": "ok",
        "mode": EFFECTIVE_MODE,
        "model": MODEL_ID.get(EFFECTIVE_MODE, "stub"),
        "device": _current_device_str(),
        "ready": bool(ml_ok),
        "loaded": _is_loaded(EFFECTIVE_MODE),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("starting: mode=%s model=%s max_side=%s threshold=%s max_tags=%s "
             "max_concurrency=%s max_upload_mb=%s",
             EFFECTIVE_MODE, MODEL_ID.get(EFFECTIVE_MODE), CFG["MAX_SIDE"],
             CFG["THRESHOLD"], CFG["MAX_TAGS"], CFG["MAX_CONCURRENCY"],
             CFG["MAX_UPLOAD_MB"])
    if CFG["EAGER"] and EFFECTIVE_MODE != "stub":
        # load in a background thread so startup/health stay responsive
        threading.Thread(
            target=_safe_eager_load, name="eager-load", daemon=True
        ).start()
    yield
    log.info("shutting down")


def _safe_eager_load():
    try:
        _ensure_loaded(EFFECTIVE_MODE)
    except Exception as exc:
        log.error("eager load failed: %s", exc)


app = FastAPI(title="dataset-studio tagger", lifespan=lifespan)


@app.get("/health")
async def health():
    # Fast, no I/O, never triggers a model download.
    return JSONResponse(_health_payload())


@app.post("/warmup")
async def warmup():
    mode = EFFECTIVE_MODE
    try:
        await run_in_threadpool(_ensure_loaded, mode)
    except Exception as exc:
        log.error("warmup failed: %s", exc)
        payload = _health_payload()
        payload["status"] = "error: %s" % exc
        return JSONResponse(payload, status_code=503)
    return JSONResponse(_health_payload())


@app.post("/tag")
async def tag(request: Request):
    # Parse the multipart form. Newer Starlette caps part size at 1MB by
    # default; raise it above MAX_UPLOAD_MB so oversize files reach our
    # per-image size check (per-image error entry) instead of failing the
    # whole request.
    max_part = int(CFG["MAX_UPLOAD_MB"] * 1024 * 1024) + 64 * 1024
    try:
        form = await request.form(max_part_size=max_part)
    except TypeError:  # older starlette without the kwarg
        form = await request.form()
    except Exception as exc:
        return JSONResponse({"error": "malformed multipart form: %s" % exc},
                            status_code=400)

    files = [
        f for f in form.getlist("files")
        if isinstance(f, (UploadFile, StarletteUploadFile))
    ]
    if not files:
        return JSONResponse(
            {"error": "no files uploaded (multipart field name must be 'files')"},
            status_code=400,
        )

    # optional threshold
    threshold = CFG["THRESHOLD"]
    raw = form.get("threshold")
    if raw not in (None, ""):
        try:
            threshold = float(raw)
        except ValueError:
            return JSONResponse(
                {"error": "threshold must be a float, got %r" % (raw,)},
                status_code=400,
            )
        if not (0.0 <= threshold <= 1.0):
            return JSONResponse(
                {"error": "threshold must be between 0 and 1, got %s" % threshold},
                status_code=400,
            )

    # optional max_tags
    max_tags = CFG["MAX_TAGS"]
    raw = form.get("max_tags")
    if raw not in (None, ""):
        try:
            max_tags = int(raw)
        except ValueError:
            return JSONResponse(
                {"error": "max_tags must be an int, got %r" % (raw,)},
                status_code=400,
            )
        if max_tags < 1:
            return JSONResponse(
                {"error": "max_tags must be >= 1, got %s" % max_tags},
                status_code=400,
            )

    # optional mode override
    mode = EFFECTIVE_MODE
    raw = form.get("mode")
    if raw not in (None, ""):
        mode = str(raw).lower()
        if mode not in VALID_MODES:
            return JSONResponse(
                {"error": "mode must be one of %s, got %r" % (VALID_MODES, raw)},
                status_code=400,
            )
    if mode != "stub" and not _ml_available():
        return JSONResponse(
            {"error": "mode=%s requires torch+transformers (install "
                      "requirements-ml.txt); server is running in stub mode" % mode},
            status_code=400,
        )

    # optional caption flag
    want_caption = True
    raw = form.get("caption")
    if raw not in (None, ""):
        want_caption = str(raw).strip().lower() in ("1", "true", "yes", "on")

    # read uploads (filename stem = image id, echoed back, order preserved)
    items = []
    for f in files:
        data = await f.read()
        fname = f.filename or "image"
        stem = PurePath(fname).stem or "image"
        items.append((stem, data))

    opts = {
        "mode": mode,
        "threshold": threshold,
        "max_tags": max_tags,
        "caption": want_caption,
    }
    results = await run_in_threadpool(_process_batch, items, opts)
    return JSONResponse({"results": results})


def main():
    import uvicorn

    uvicorn.run(app, host=CFG["HOST"], port=CFG["PORT"], log_level="info")


if __name__ == "__main__":
    main()
