# Build context is the repo root (see docker-compose.yml) so brand.json is available.
FROM node:22.23.3-alpine AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json backend/.npmrc ./
RUN npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.3-alpine
ENV NODE_ENV=production
WORKDIR /app/backend
COPY brand.json /app/brand.json
COPY --from=build /app/backend/package.json ./
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/backend/dist/cli.js "$@"\n' > /usr/local/bin/sayl-admin \
  && chmod +x /usr/local/bin/sayl-admin \
  && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node:sqlite is stable in practice but still flagged experimental in Node 22
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
