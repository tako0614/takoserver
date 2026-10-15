FROM oven/bun:1.4.0@sha256:18639686662e5cd8a963ffb967dd130034a2a2d076a52e65dfd4fe18f75cc038
COPY server.ts /app/server.ts
EXPOSE 8080/tcp
ENTRYPOINT ["bun", "--no-env-file", "/app/server.ts"]
