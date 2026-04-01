FROM node:20-alpine AS base

# Install Python + pip + numpy/aiohttp for the visualiser
RUN apk add --no-cache python3 py3-pip py3-numpy && \
    pip3 install aiohttp --break-system-packages

WORKDIR /app

# Node deps
COPY package.json ./
RUN npm install --omit=dev

# App files
COPY server.js visualiser.py ./
COPY public/ ./public/

# Data dir (bind mount this in production)
RUN mkdir -p /data

ENV DATA_DIR=/data
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
