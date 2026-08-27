# 身内用 Discord Bot。データは /app/data（SQLite と出品画像）に置く。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    DATABASE_PATH=/app/data/economy.db \
    IMAGE_DIR=/app/data/images

# 依存だけ先に入れてキャッシュを効かせる（better-sqlite3 はビルド済みバイナリを使う）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
