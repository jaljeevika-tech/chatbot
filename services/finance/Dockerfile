# FieldFlow Finance Service — Cloud Run container
# Bounded Context: Finance (DDD)
# Owns: fm_settings, fm_counters, fm_files, fm_advances, fm_settlements,
#       fm_settlement_lines, fm_advance_adjustments, fm_ledger_requests,
#       fm_events, fm_notifications
# Build context is the REPO ROOT (reuses lib/serviceApp.js):
#   docker build -f services/finance/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/finance/package.json ./package.json
RUN npm install --omit=dev

COPY lib/serviceApp.js lib/internalCaller.js lib/correlationId.js ./lib/
COPY services/finance/index.js ./services/finance/
COPY services/finance/src ./services/finance/src

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/finance/index.js"]
