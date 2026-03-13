FROM oven/bun:1 AS base
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY bun.lock package.json tsconfig.json ./
RUN bun install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY prisma ./prisma
COPY assets ./assets
COPY src ./src
RUN bunx prisma generate

# ---- runtime ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package.json /app/bun.lock /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/assets ./assets
COPY --from=build /app/src ./src

EXPOSE 3000

# Default runs the HTTP API; docker-compose also runs the bot.
CMD ["bun", "run", "src/server.ts"]

