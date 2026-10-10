# Verity service container. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t verity-api .
# Not yet exercised in CI: verify on the first deployment.

FROM node:24-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci --ignore-scripts && npm run build -w @verity/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @verity/api --ignore-scripts && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle

# Public Supabase CA certificate for verified database TLS
COPY apps/api/certs/prod-ca-2021.crt /repo/apps/api/certs/prod-ca-2021.crt
ENV VERITY_DB_CA_PATH=/repo/apps/api/certs/prod-ca-2021.crt

WORKDIR /repo/apps/api
USER node
EXPOSE 8787

CMD ["node", "dist/server.js"]COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle

# Public Supabase CA certificate for verified database TLS
COPY apps/api/certs/prod-ca-2021.crt /repo/apps/api/certs/prod-ca-2021.crt
ENV VERITY_DB_CA_PATH=/repo/apps/api/certs/prod-ca-2021.crt

WORKDIR /repo/apps/api
USER node
EXPOSE 8787

CMD ["node", "dist/server.js"]