# Multi-arch production image: web + gateway + migrate in one image.
# Usage:
#   web:     command: ["web"]
#   gateway: command: ["gateway"]
#   migrate: command: ["migrate"]

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @class-comfyui/database build
RUN pnpm --filter @class-comfyui/gateway build
RUN pnpm --filter @class-comfyui/web build

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl \
  && addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public 2>/dev/null || true
COPY --from=builder /app/apps/gateway/dist ./gateway/dist
COPY --from=builder /app/apps/gateway/package.json ./gateway/package.json
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/package.json ./packages/database/package.json
COPY --from=builder /app/node_modules ./node_modules
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && chown -R app:app /app
USER app
EXPOSE 3000 8081
ENTRYPOINT ["./docker-entrypoint.sh"]
