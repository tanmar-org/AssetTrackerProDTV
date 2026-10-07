# Pinned official multi-platform manifests, verified 2026-10-06. Build on the
# destination architecture; copied image archives require matching architecture.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
WORKDIR /opt/assettracker
COPY . .
ARG PUBLIC_QR_URL
ENV NEXT_TELEMETRY_DISABLED=1
# Public URL is the sole environment-specific build input; never pass a runtime
# credential as a build argument or use host-generated dotenv/dependency files.
RUN node scripts/set-container-public-url.mjs "$PUBLIC_QR_URL" \
 && npm ci --no-audit --no-fund \
 && npm --prefix service-request ci --no-audit --no-fund \
 && npm run build \
 && npm --prefix service-request run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm --prefix service-request prune --omit=dev --no-audit --no-fund

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS app
WORKDIR /opt/assettracker
COPY --from=builder /opt/assettracker /opt/assettracker
# The same immutable release supports three distinct Compose UIDs/credentials;
# only the active app's cache and /tmp are writable at runtime.
RUN mkdir -p /run/assettracker-credentials /var/run/postgresql
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production CREDENTIALS_DIRECTORY=/run/assettracker-credentials
USER 10001:10001
ENTRYPOINT ["node", "scripts/run-container-service.mjs"]
CMD ["staff"]

FROM postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c AS postgres
# PG18 uses a versioned PGDATA below /var/lib/postgresql. Persist the parent,
# not the old pre-18 /var/lib/postgresql/data path. Never publish a database port.
COPY deploy/docker/pg_hba.conf /etc/postgresql/assettracker-hba.conf
RUN mkdir -p /var/lib/postgresql/18/docker /var/run/postgresql \
 && chown -R 999:999 /var/lib/postgresql /var/run/postgresql \
 && chmod 0755 /var/run/postgresql
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
USER 999:999
CMD ["postgres", "-c", "listen_addresses=", "-c", "hba_file=/etc/postgresql/assettracker-hba.conf", "-c", "unix_socket_permissions=0777", "-c", "password_encryption=scram-sha-256"]

FROM postgres AS operator
# Same Debian release/PG major as the database; private peer administration is
# scoped to this separate profile and UID. No operator secret reaches web apps.
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=app /opt/assettracker /opt/assettracker
RUN mkdir -p /operator && chown 999:999 /operator && chmod 0700 /operator
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /opt/assettracker
USER 999:999
ENTRYPOINT ["node", "scripts/container-operator.mjs"]
CMD ["help"]

FROM nginx:1.30.5-trixie@sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb AS gateway
COPY deploy/docker/gateway-main.conf /etc/nginx/nginx.conf
COPY deploy/docker/start-gateway.sh /usr/local/bin/assettracker-gateway
RUN mkdir -p /etc/nginx/runtime && chmod 0755 /usr/local/bin/assettracker-gateway
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
USER 10004:10004
ENTRYPOINT ["/usr/local/bin/assettracker-gateway"]
