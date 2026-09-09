# Node 24 provides the same SQLite engine on amd64 and arm64; no native npm addon.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.12.0
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/gateway/dist/index.cjs ./gateway/index.cjs
COPY --from=build --chown=node:node /app/packages/database/dist/*.cjs ./database/
COPY --chmod=755 scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /data/audit /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000 8081
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["web"]
