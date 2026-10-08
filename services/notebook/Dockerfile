# FieldFlow Notebook AI — sources → chat, study guide, slide deck, mind map, flashcards, guide (SSE) — Cloud Run container
# Build from the REPO ROOT: docker build -f services/notebook/Dockerfile .
# (it reuses the monolith's lib/ helpers rather than copying them).

FROM node:22-slim

WORKDIR /app

COPY services/notebook/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/internalCaller.js lib/gemini.js lib/promptStore.js lib/usageTracker.js lib/aiContext.js lib/orgMetaCache.js lib/extractDocumentText.js lib/extractWebArticle.js lib/tts.js lib/ssrfGuard.js ./lib/
COPY lib/prompts ./lib/prompts
COPY db/pool.js ./db/
COPY services/notebook/index.js ./services/notebook/
COPY services/notebook/src ./services/notebook/src

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/notebook/index.js"]
