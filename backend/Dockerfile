FROM node:24.22.3-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependências primeiro, para aproveitar o cache de camadas. Versões exatas vêm do package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
