# syntax=docker/dockerfile:1

FROM oven/bun:1 AS bun

FROM rust:1-bookworm AS build-tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install --git https://github.com/bytematebot/byteorm --rev 85a51b04 byteorm --locked
WORKDIR /src

FROM build-tools AS source
COPY . .
RUN cd apps/backend && byteorm generate && test -s generated/src/lib.rs

FROM source AS backend-build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p vanilla-backend --bin vanilla-backend \
    && cp target/release/vanilla-backend /usr/local/bin/vanilla-backend

FROM build-tools AS frontend-tools
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.lock /tmp/vanilla-Cargo.lock
RUN version=$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"/\1/p;}' /tmp/vanilla-Cargo.lock) \
    && test -n "$version" \
    && cargo install wasm-bindgen-cli --version "$version" --locked

FROM frontend-tools AS frontend-build
WORKDIR /src/apps/frontend
COPY apps/frontend/package.json apps/frontend/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY --from=source /src /src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target bun run build

FROM nginx:stable-alpine AS frontend
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /src/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 vanilla \
    && useradd --uid 10001 --gid vanilla --no-create-home vanilla
WORKDIR /app

FROM runtime AS migrate
COPY --from=build-tools /usr/local/cargo/bin/byteorm /usr/local/bin/byteorm
COPY --chown=vanilla:vanilla apps/backend/byteorm ./byteorm
COPY --chmod=755 deploy/migrate.sh /usr/local/bin/migrate
USER vanilla
ENTRYPOINT ["/usr/local/bin/migrate"]

FROM runtime AS backend
COPY --from=backend-build /usr/local/bin/vanilla-backend /usr/local/bin/vanilla-backend
COPY --chown=vanilla:vanilla apps/backend/cdn/embed ./cdn/embed
RUN chown vanilla:vanilla /app/cdn
ENV NODE_ENV=production PORT=3000 RUST_LOG=vanilla_backend=info,tower_http=info
USER vanilla
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD curl --fail --silent http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/usr/local/bin/vanilla-backend"]
