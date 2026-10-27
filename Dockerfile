# Match .bun-version; retain the verified multi-platform image digest.
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598

WORKDIR /opt/takoserver
COPY package.json bun.lock ./
# Hono is currently a devDependency but is also used by the Bun HTTP entry.
RUN bun install --frozen-lockfile
COPY src ./src
COPY config/shared-hosted-pricing.json ./config/shared-hosted-pricing.json
COPY config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json ./config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json
COPY config/shared-hosted-pricing-revisions/hosted-20261015-container-proposed-v1.json ./config/shared-hosted-pricing-revisions/hosted-20261015-container-proposed-v1.json
COPY vendor/takoform/v2.1.1 ./vendor/takoform/v2.1.1
COPY LICENSE ./LICENSE
COPY scripts/operator-key.ts ./scripts/operator-key.ts
COPY scripts/selfhost-artifact.ts ./scripts/selfhost-artifact.ts

RUN mkdir -p /var/lib/takoserver \
    && chmod -R u=rwX,go=rX /opt/takoserver \
    && chown bun:bun /var/lib/takoserver \
    && chmod 0700 /var/lib/takoserver
ENV TAKOSERVER_DATA_ROOT=/var/lib/takoserver \
    TAKOSERVER_LISTEN_HOST=0.0.0.0 \
    PORT=8787
USER bun
EXPOSE 8787/tcp
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD bun --no-env-file -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8787}/_takoserver/health/ready`, {signal: AbortSignal.timeout(4000)}); await r.arrayBuffer(); process.exit(r.status === 200 ? 0 : 1)'
ENTRYPOINT ["bun", "--no-env-file", "src/entry-bun.ts"]
