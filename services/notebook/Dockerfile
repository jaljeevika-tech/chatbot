# FieldFlow Notebook Service — Cloud Run container
# Stateless: no DB, no persistent state. Purely Gemini API calls.

FROM node:22-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY index.js ./

# Cloud Run sets PORT automatically; default to 8080 for local dev
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
