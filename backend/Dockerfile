FROM rust:1.96-trixie AS build
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        clang \
        git \
        libclang-dev \
        libgdal-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
RUN --mount=type=cache,id=arvo-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=arvo-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=arvo-cargo-target,target=/build/target \
    cargo build --locked --release \
        -p arvo-api \
        -p arvo-worker \
        --features arvo-api/imagery,arvo-worker/imagery \
    && cp /build/target/release/arvo-api /tmp/arvo-api \
    && cp /build/target/release/arvo-worker /tmp/arvo-worker

FROM debian:trixie-slim AS runtime
ENV RUST_LOG=arvo_api=info,tower_http=info
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgdal36 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 arvo \
    && useradd --system --uid 10001 --gid arvo --home-dir /app arvo \
    && mkdir -p /var/lib/arvo/uploads /var/lib/arvo/store /var/lib/arvo/tiles \
    && chown -R arvo:arvo /app /var/lib/arvo

COPY --from=build --chown=arvo:arvo /tmp/arvo-api /usr/local/bin/arvo-api
COPY --from=build --chown=arvo:arvo /tmp/arvo-worker /usr/local/bin/arvo-worker
USER arvo
EXPOSE 8787
CMD ["arvo-api", "serve"]
