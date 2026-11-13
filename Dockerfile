# Admin service image: build the bundles, then ship only what runs.
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build -w @om/admin

FROM node:22-slim
# Runtime: one bundle plus the rubric the review step reads. No signing key, no git, no shell tools needed.
WORKDIR /app
COPY --from=build /src/packages/admin/dist/admin.cjs ./admin.cjs
COPY rubric ./rubric
RUN useradd --system --uid 10001 --no-create-home om && mkdir -p /data /audit /config && chown om /data /audit
USER om
# /data       registry output (read-write here, read-only for the web server container)
# /audit      admin audit log (kept out of the served registry tree)
# /config     admin.config.json, registry.config.json, admin-users.json, public-key.txt, TLS certs (mounted read-only)
VOLUME ["/data", "/audit"]
EXPOSE 8443
ENTRYPOINT ["node", "/app/admin.cjs"]
CMD ["serve", "--config", "/config/admin.config.json"]
