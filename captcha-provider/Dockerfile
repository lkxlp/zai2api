FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		chromium \
		fonts-liberation \
		fonts-noto-cjk \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

EXPOSE 9876

CMD ["node", "server.js"]
