# steam-auth/Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:18700/health || exit 1

EXPOSE 18700

CMD ["node", "server.js"]