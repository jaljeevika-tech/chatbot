# FieldFlow Micro-Entrepreneur Registration Service — Cloud Run container
# Bounded Context: Micro-Entrepreneur Registration (DDD)
# Owns: micro_entrepreneurs, micro_entrepreneur_seq tables
# Reads (never writes): me_registration_tokens (minted by the monolith),
# lgd_states/lgd_districts/lgd_blocks/lgd_panchayats/lgd_villages (reference data)
#
# Build from the REPO ROOT (it shares services/registration-shared and lib/):
#   docker build -f services/micro-entrepreneur/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/micro-entrepreneur/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/lgdRouter.js ./lib/
COPY services/registration-shared ./services/registration-shared
COPY services/micro-entrepreneur/index.js ./services/micro-entrepreneur/
COPY services/micro-entrepreneur/public ./services/micro-entrepreneur/public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/micro-entrepreneur/index.js"]
