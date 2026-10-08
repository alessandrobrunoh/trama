# syntax=docker/dockerfile:1.7
# Build context: the repository root (the Dockerfile lives in mcp/):
#   docker build -f mcp/Dockerfile -t ghcr.io/alessandrobrunoh/trama-mcp:latest .
FROM rust:1-bookworm AS build
WORKDIR /src
# Dependencies first: this layer is rebuilt only when Cargo.toml / Cargo.lock change.
COPY mcp/Cargo.toml mcp/Cargo.lock ./
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked && rm -rf src target/release/deps/trama_mcp* target/release/trama-mcp
COPY mcp/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    touch src/main.rs && cargo build --release --locked \
 && cp target/release/trama-mcp /trama-mcp

# distroless/cc: glibc, libgcc and CA certificates only. No shell, no package manager, non-root.
FROM gcr.io/distroless/cc-debian12:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="trama-mcp" org.opencontainers.image.version="${VERSION}" org.opencontainers.image.source="https://github.com/alessandrobrunoh/trama"
COPY --from=build /trama-mcp /usr/local/bin/trama-mcp
# TRAMA_API_URL: base URL of the Trama API as seen from this container.
ENV TRAMA_API_URL=http://trama-api:3000/api \
    MCP_BIND=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=3s --retries=3 \
  CMD ["/usr/local/bin/trama-mcp", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/trama-mcp"]
