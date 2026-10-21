# Dataset Studio tagging sidecar.
#
# Default build: CPU torch on linux/amd64.
#   docker build -t tagger ./tagger
#
# CUDA build (switch the wheel index via build arg):
#   docker build -t tagger \
#     --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 \
#     ./tagger
#   (run with --gpus all; you may also want a CUDA runtime base image
#    instead of slim for full GPU support)

FROM --platform=linux/amd64 python:3.11-slim

# CPU wheel index by default; override with:
#   --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

WORKDIR /app

# base deps first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ML deps: torch from the selected wheel index, then transformers & friends
COPY requirements-ml.txt .
RUN pip install --no-cache-dir torch --index-url ${TORCH_INDEX} \
    && pip install --no-cache-dir -r requirements-ml.txt

COPY app.py .

ENV HOST=0.0.0.0 \
    PORT=8790 \
    MODE=auto \
    DEVICE=auto

EXPOSE 8790

CMD ["sh", "-c", "uvicorn app:app --host ${HOST} --port ${PORT}"]
