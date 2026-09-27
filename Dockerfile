FROM ghcr.io/foundry-rs/foundry:v1.5.1 AS foundry

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
RUN npm install --global pnpm@10.8.1
COPY . .
RUN pnpm install --filter @metropolis/backend --filter @metropolis/contracts --frozen-lockfile
RUN pnpm contracts:build && pnpm backend:build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/app/packages/backend/certs/supabase-prod-ca-2021.crt
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/certs ./packages/backend/certs
COPY --from=build /app/packages/contracts/out ./packages/contracts/out
USER node
EXPOSE 3001
CMD ["node", "packages/backend/dist/src/main.js"]
