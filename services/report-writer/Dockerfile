# FieldFlow Report Writer — voice profiles, glossary, feedback (RW_SHEET_ID Google Sheet) + AI drafting (SSE) — Cloud Run container
# Build from the REPO ROOT: docker build -f services/report-writer/Dockerfile .
# (it reuses the monolith's lib/ helpers rather than copying them).

FROM node:22-slim

WORKDIR /app

COPY services/report-writer/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/internalCaller.js lib/gemini.js lib/promptStore.js lib/usageTracker.js lib/aiContext.js lib/orgMetaCache.js lib/sheets.js ./lib/
COPY lib/prompts ./lib/prompts
COPY db/pool.js ./db/
COPY services/report-writer/index.js ./services/report-writer/
COPY services/report-writer/src ./services/report-writer/src

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/report-writer/index.js"]
