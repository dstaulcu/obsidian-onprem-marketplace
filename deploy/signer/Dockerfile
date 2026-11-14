# Signer image: the ONLY container that holds the registry signing key. It signs approvals the admin asks for, after re-checking the
# files and the review itself. No ports, no network (see docker-compose.yml), registry mounted read-only. Build context is the repo root.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build -w @om/sync

FROM node:22-slim
WORKDIR /app
# .mjs because the bundle is an ES module
COPY --from=build /src/packages/sync/dist/cli.js ./om-sync.mjs
RUN useradd --system --uid 10001 --no-create-home om
USER om
# /data           registry (read-only)
# /signq          requests from the admin and answers back (shared volume)
# /run/secrets    the signing key, from your secret store (Docker secret, Kubernetes secret, ...)
# /config         public-key.txt, read-only: the signer refuses to start if its key does not match it
ENTRYPOINT ["node", "/app/om-sync.mjs"]
CMD ["sign-worker", "--queue", "/signq", "--registry", "/data", "--key-file", "/run/secrets/signing-key", "--public-key", "/config/public-key.txt"]
