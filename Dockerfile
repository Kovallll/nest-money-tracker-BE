FROM node:22-slim

WORKDIR /app

# Copy package files
COPY backend/package*.json ./
COPY backend/yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy proto files
RUN mkdir -p /app/proto
COPY proto/categorizer.proto /app/proto/

# Copy source code
COPY backend/ .

# Build application
RUN yarn build

# Expose default port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["yarn", "start:prod"]