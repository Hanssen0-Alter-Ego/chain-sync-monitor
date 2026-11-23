FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web
RUN install -d -m 0700 -o 65532 -g 65532 /data && touch /data/.keep && chown 65532:65532 /data/.keep

USER 65532:65532
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/server/backend/src/index.js", "--config", "/config/config.toml", "--host", "0.0.0.0", "--port", "8080", "--history", "/data/history.sqlite3"]
