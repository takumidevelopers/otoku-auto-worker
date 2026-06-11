FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]