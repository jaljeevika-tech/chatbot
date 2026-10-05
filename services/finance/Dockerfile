# FieldFlow Finance Service — Cloud Run container
# Bounded Context: Finance (DDD)
# Owns: fm_settings, fm_counters, fm_files, fm_advances, fm_settlements,
#       fm_settlement_lines, fm_advance_adjustments, fm_ledger_requests,
#       fm_events, fm_notifications

FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY src ./src

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
