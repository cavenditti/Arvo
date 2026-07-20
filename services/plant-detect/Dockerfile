# syntax=docker/dockerfile:1
FROM python:3.11-slim

# STORE_DIR is the object-store root the request keys resolve against: bind-mount the repo's
# `backend/var/store` here (docs/API-PLANT.md §"Storage layout").
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    STORE_DIR=/var/store \
    PORT=8788

WORKDIR /srv/plant-detect

# rasterio's manylinux wheel bundles GDAL/PROJ, so there is no GDAL build here. It does link
# libexpat, which the manylinux policy allowlists (hence not vendored) and `-slim` omits —
# without it `import rasterio` dies with "libexpat.so.1: cannot open shared object file".
RUN apt-get update \
    && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --system --uid 10001 detect && mkdir -p /var/store && chown detect /var/store
USER detect

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8788')+'/health').read()"]

# One worker per core; each request is CPU-bound (numpy/scipy release the GIL).
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8788} --workers ${WEB_CONCURRENCY:-2}"]
