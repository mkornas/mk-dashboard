# mk-dashboard — one container: the Angular app built here, served by the
# Fastify API. No native modules, no build step at runtime (Node 24 runs the
# TypeScript sources directly).

# ---- build the frontend ----
FROM node:24-alpine AS web
WORKDIR /build
COPY shared/ ./shared/
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --no-fund
COPY client/ ./client/
RUN cd client && npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY shared/ ./shared/
COPY server/ ./server/
COPY --from=web /build/client/dist/client/browser ./web

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
ENV DASH_STATIC_DIR=/app/web
ENV HOST_PROC=/host/proc
ENV HOST_SYS=/host/sys
ENV HOST_ROOT=/host/root
ENV PORT=8800
EXPOSE 8800

WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8800/api/health || exit 1
CMD ["node", "src/index.ts"]
