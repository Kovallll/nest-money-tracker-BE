FROM node:22-slim

WORKDIR /app

# Copy package files (Yarn 4 reads packageManager + .yarnrc.yml)
COPY package*.json ./
COPY yarn.lock ./
COPY .yarnrc.yml ./

# package.json pins yarn@4.x — use Corepack, not global Yarn 1.x from the image
RUN corepack enable

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN yarn build

# Expose default port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["yarn", "start:prod"]