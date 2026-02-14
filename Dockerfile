FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN yarn install


RUN mkdir -p /app/proto
COPY ml-service/categorizer.proto /app/proto/

COPY . .

RUN yarn build

EXPOSE 5000

CMD ["node", "dist/main.js"]