# FieldFlow Resource Registration Service — Cloud Run container
# Bounded Context: Resource Registration (DDD)
# Owns: resources, resource_seq tables
# Reads (never writes): rs_registration_tokens (minted by the monolith),
# individual_beneficiaries/micro_entrepreneurs/collectives (beneficiary UID
# lookup only — see db/migrations/043_resources.sql for the scoped grants),
# lgd_states/lgd_districts/lgd_blocks/lgd_panchayats/lgd_villages (reference data)

FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
