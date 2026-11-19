# Slopboard: collector, API and UI in one Bun process.
FROM oven/bun:1.4.5-slim

WORKDIR /app

# Dependencies first, so editing source does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8318
EXPOSE 8318

USER bun

# Healthy means "the database answers". A proxy that is down shows up as
# collectorLagSeconds in /api/health, not as an unhealthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 8318) + '/api/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "src/server/main.ts"]
