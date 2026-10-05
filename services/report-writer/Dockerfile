# FieldFlow Report Writer Service — Cloud Run container
# Bounded Context: Report Writer (DDD)
# Owns: rw_profiles, rw_glossary, rw_drafts, rw_feedback tables

FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
