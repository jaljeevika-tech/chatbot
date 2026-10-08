# FieldFlow Individual Beneficiary Registration Service — Cloud Run container
# Bounded Context: Individual Beneficiary Registration (DDD)
# Owns: individual_beneficiaries, individual_beneficiary_seq tables
# Reads (never writes): ib_registration_tokens (minted by the monolith)
#
# Build from the REPO ROOT (it shares services/registration-shared and lib/):
#   docker build -f services/individual-beneficiary/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/individual-beneficiary/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/lgdRouter.js ./lib/
COPY services/registration-shared ./services/registration-shared
COPY services/individual-beneficiary/index.js ./services/individual-beneficiary/
COPY services/individual-beneficiary/public ./services/individual-beneficiary/public

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/individual-beneficiary/index.js"]
