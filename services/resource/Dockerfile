# FieldFlow Resource Registration Service — Cloud Run container
# Bounded Context: Resource Registration (DDD)
# Owns: resources, resource_seq tables
# Reads (never writes): rs_registration_tokens (minted by the monolith),
# individual_beneficiaries/micro_entrepreneurs/collectives (beneficiary UID
# lookup only — see db/migrations/043_resources.sql for the scoped grants),
# lgd_states/lgd_districts/lgd_blocks/lgd_panchayats/lgd_villages (reference data)
#
# Build from the REPO ROOT (it shares services/registration-shared and lib/):
#   docker build -f services/resource/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/resource/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js ./lib/
COPY services/registration-shared ./services/registration-shared
COPY services/resource/index.js ./services/resource/
COPY services/resource/public ./services/resource/public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/resource/index.js"]
