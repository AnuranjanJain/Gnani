# Samajh — production image (Node 24 to match local dev/test).
FROM node:24-slim

WORKDIR /app

# Install production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what stays out of the image).
COPY . .

# Render/Railway inject PORT at runtime; 3000 is the local default.
ENV NODE_ENV=production PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
