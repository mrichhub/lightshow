FROM node:24.11.0-bookworm-slim AS base
WORKDIR /app
RUN npm install -g pnpm@10.20.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/ui/package.json ./apps/ui/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM nginx:1.28.0-alpine AS ui
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=base /app/apps/ui/dist /usr/share/nginx/html
HEALTHCHECK CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
