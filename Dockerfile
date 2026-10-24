FROM node:24.22.1-bookworm-slim AS base
WORKDIR /app
RUN npm install -g pnpm@10.20.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/ui/package.json ./apps/ui/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/show-engine/package.json ./apps/show-engine/package.json
COPY apps/esp-simulator/package.json ./apps/esp-simulator/package.json
COPY packages/models/package.json ./packages/models/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
COPY packages/effects/package.json ./packages/effects/package.json
COPY packages/ddp/package.json ./packages/ddp/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
RUN mkdir -p /state && chown node:node /state
USER node
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM nginx:1.30.6-alpine AS ui
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=base /app/apps/ui/dist /usr/share/nginx/html
HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
