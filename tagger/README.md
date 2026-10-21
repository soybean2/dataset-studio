# Tagger sidecar

FastAPI service producing booru-style tags + captions for dataset images
using local models (WD Tagger or BLIP), plus a dependency-light **stub**
mode for development without torch.

## Endpoints

| Method | Path      | Purpose |
|--------|-----------|---------|
| GET    | `/health` | Fast status; never downloads a model. |
| POST   | `/tag`    | multipart `files` (repeatable) -> `{"results":[{id,tags,caption,error}]}` |
| POST   | `/warmup` | Eagerly load model weights; returns `/health` shape. |

`POST /tag` optional form fields: `threshold` (float), `max_tags` (int),
`mode` (`stub|wd|blip`, overrides env for this request), `caption` (`1|0`).
The `id` is the filename stem, entries are returned in upload order, and a
failure on one image yields `"error"` on that entry only (batch stays 200).

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `HOST` | `0.0.0.0` | bind host |
| `PORT` | `8790` | bind port |
| `MODE` | `auto` | `auto` = `wd` if torch+transformers importable, else `stub` |
| `WD_MODEL` | `SmilingWolf/wd-vit-tagger-v3` | HF repo for wd mode |
| `BLIP_MODEL` | `Salesforce/blip-image-captioning-base` | HF repo for blip mode |
| `DEVICE` | `auto` | `auto` = cuda if available else cpu |
| `THRESHOLD` | `0.35` | default tag score threshold |
| `MAX_TAGS` | `30` | default tag cap |
| `MAX_SIDE` | `1024` | downscale longer edge before inference |
| `DROP_RATING` | `1` | remove `rating:*` tags |
| `EAGER` | `0` | `1` = load model at startup |
| `MAX_CONCURRENCY` | `1` | semaphore cap on concurrent inferences |
| `MAX_UPLOAD_MB` | `40` | per-file size limit (over-limit -> per-image error) |

## Run stub mode locally (no torch needed)

```bash
cd tagger
python -m venv .venv && . .venv/Scripts/activate   # Linux: .venv/bin/activate
pip install -r requirements.txt
MODE=stub python app.py        # listens on :8790
```

Stub mode still decodes images with Pillow (corrupt uploads produce a
per-image error) and returns deterministic hash-derived pseudo-tags. The
caption embeds the real pixel size, e.g. `stub 1024x768: 1girl, solo, ...`.

## Run with real models

```bash
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu   # or your CUDA index
pip install -r requirements-ml.txt
MODE=wd python app.py       # first /tag or /warmup downloads the model
```

## Docker

```bash
docker build -t tagger .                                     # CPU torch
docker build -t tagger --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 .  # CUDA
docker run --rm -p 8790:8790 tagger
```

## curl examples

```bash
curl -s http://localhost:8790/health

curl -s -X POST http://localhost:8790/tag \
  -F files=@img1.png -F files=@img2.jpg \
  -F threshold=0.4 -F max_tags=20 -F caption=1

curl -s -X POST http://localhost:8790/tag \
  -F files=@img1.png -F mode=stub

curl -s -X POST http://localhost:8790/warmup
```
