# syntax=docker/dockerfile:1.7
# Trama web app (Angular, static) served by unprivileged nginx. Build context: repo root
#   docker build -t ghcr.io/alessandrobrunoh/trama-frontend:latest .

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY angular.json tsconfig.json tsconfig.app.json ngsw-config.json .postcssrc.json ./
COPY public ./public
COPY src ./src
RUN npx ng build --configuration production \
 # pre-compress once, so nginx serves .gz files with gzip_static instead of compressing per request
 && find dist/delta/browser -type f \
      \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
         -o -name '*.json' -o -name '*.webmanifest' -o -name '*.txt' -o -name '*.xml' \) \
      -exec gzip -9 -k {} +

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="trama-frontend" org.opencontainers.image.version="${VERSION}" org.opencontainers.image.source="https://github.com/alessandrobrunoh/trama"
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist/delta/browser /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
