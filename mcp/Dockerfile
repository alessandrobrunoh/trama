# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
WORKDIR /src
# Build dependencies first so source edits don't invalidate this layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home mcp
COPY --from=build /src/target/release/nabla-mcp /usr/local/bin/nabla-mcp
USER mcp
# NABLA_API_URL: base URL of the Nabla API as seen from this container.
ENV NABLA_API_URL=http://app:3000/api \
    MCP_BIND=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /healthz HTTP/1.0\r\n\r\n" >&3 && grep -q ok <&3'
ENTRYPOINT ["nabla-mcp"]
