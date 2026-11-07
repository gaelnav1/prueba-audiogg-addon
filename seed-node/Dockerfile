FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV DATA_DIR=/data
VOLUME ["/data"]
CMD ["npm","start"]
