# FieldFlow Collective Registration Service — Cloud Run container
# Bounded Context: Collective Registration (DDD)
# Owns: collectives, collective_seq tables
# Reads (never writes): cb_registration_tokens (minted by the monolith),
# lgd_states/lgd_districts/lgd_blocks/lgd_panchayats/lgd_villages (reference data)

FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY crypto.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
