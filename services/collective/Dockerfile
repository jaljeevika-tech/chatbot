# FieldFlow Collective Registration Service — Cloud Run container
# Bounded Context: Collective Registration (DDD)
# Owns: collectives, collective_seq tables
# Reads (never writes): cb_registration_tokens (minted by the monolith),
# lgd_states/lgd_districts/lgd_blocks/lgd_panchayats/lgd_villages (reference data)
#
# Build from the REPO ROOT (it shares services/registration-shared and lib/):
#   docker build -f services/collective/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/collective/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/lgdRouter.js ./lib/
COPY services/registration-shared ./services/registration-shared
COPY services/collective/index.js ./services/collective/
COPY services/collective/public ./services/collective/public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/collective/index.js"]
