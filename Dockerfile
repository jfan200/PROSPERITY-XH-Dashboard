FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DEPLOY_TARGET=docker \
    DATA_DIR=/app/data \
    TAPTOUCH_SCRAPER_MODE=inline

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates \
  fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build && npm prune --omit=dev
RUN mkdir -p /app/data /app/data/debug

EXPOSE 3001

CMD ["node", "server.js"]
