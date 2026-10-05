# FieldFlow Micro-Entrepreneur Registration Service — Cloud Run container
# Bounded Context: Micro-Entrepreneur Registration (DDD)
# Owns: micro_entrepreneurs, micro_entrepreneur_seq tables
# Reads (never writes): me_registration_tokens (minted by the monolith),
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
