FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache tzdata && npm install --production

COPY server.js ./
COPY auth.js ./
COPY routes-auth.js ./
COPY public ./public

RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]
