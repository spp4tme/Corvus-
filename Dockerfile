# Corvus — image multi-architecture (linux/amd64, linux/arm64).
# Construction multi-arch : docker buildx build --platform linux/amd64,linux/arm64 -t corvus .
# Aucune compilation native : les dépendances sont 100 % JavaScript.
FROM node:24-alpine

ENV NODE_ENV=production \
    CORVUS_DATA=/data \
    BIND=127.0.0.1 \
    PORT=7680

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 7680

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server/index.js"]
