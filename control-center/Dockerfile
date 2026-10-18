FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.app.json vite.config.ts ./
COPY src ./src
COPY server.mjs fleet-projection.mjs control-proxy-boundary.mjs iap-jwt.mjs ./
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server.mjs fleet-projection.mjs control-proxy-boundary.mjs iap-jwt.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
