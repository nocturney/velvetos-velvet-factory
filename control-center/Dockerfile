FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
# node:24-alpine (Node 24.22.0) multi-arch index digest, resolved 2026-10-18 from Docker Hub.
# Bump deliberately: re-resolve the digest of the tag and update both stages together.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.app.json vite.config.ts ./
COPY src ./src
COPY public ./public
COPY fixtures ./fixtures
COPY server.mjs fleet-projection.mjs control-proxy-boundary.mjs iap-jwt.mjs ./
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server.mjs fleet-projection.mjs control-proxy-boundary.mjs iap-jwt.mjs ./
# App files stay root-owned and read-only; the server only reads them and needs no writable path.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
