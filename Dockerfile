# Corvus — image multi-architecture (linux/amd64, linux/arm64).
# Construction multi-arch : docker buildx build --platform linux/amd64,linux/arm64 -t corvus .
# Aucune compilation native : les dépendances sont 100 % JavaScript.
# Image épinglée par empreinte (index multi-arch amd64 + arm64) : un tag mobile ne peut plus changer sous nos pieds.
# Dependabot (écosystème « docker », .github/dependabot.yml) propose chaque mise à jour, à relire avant fusion.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# Métadonnées OCI : relient l'image au dépôt GitHub (registre ghcr.io, page « Packages » du dépôt).
ARG VERSION=dev
LABEL org.opencontainers.image.title="Corvus" \
      org.opencontainers.image.description="Passerelle SSH/SFTP/DevOps auto-hébergée pour votre tailnet (PWA)" \
      org.opencontainers.image.source="https://github.com/spp4tme/Corvus-" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

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
