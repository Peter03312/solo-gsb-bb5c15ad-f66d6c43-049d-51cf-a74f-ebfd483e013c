FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 使用预编译二进制，无需在镜像内编译
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p data
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DB_PATH=/app/data/lightbudget.db

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
