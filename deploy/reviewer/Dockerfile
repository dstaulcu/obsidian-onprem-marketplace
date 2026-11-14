# Reviewer image: the ONLY container that holds the model credentials. It answers prompts the admin queues and nothing
# else: no ports, no registry files, no signing key. Build context is the repository root (see docker-compose.yml).
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build -w @om/sync

FROM node:22-slim
# Pin this for reproducible builds, e.g. --build-arg CLAUDE_CODE_VERSION=<version>. "latest" is only the default.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
WORKDIR /app
# .mjs because the bundle is an ES module
COPY --from=build /src/packages/sync/dist/cli.js ./om-sync.mjs
RUN useradd --system --uid 10001 --no-create-home om
USER om
# The root file system is read-only at run time; Claude Code gets a throwaway home on a tmpfs.
ENV HOME=/tmp/home
# /queue    requests from the admin and answers back (shared volume)
# /config   registry.config.json, read-only: only its "review" section is used
ENTRYPOINT ["node", "/app/om-sync.mjs"]
CMD ["review-worker", "--queue", "/queue", "--config", "/config/registry.config.json"]
