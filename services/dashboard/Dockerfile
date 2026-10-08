# FieldFlow Dashboard Service — Cloud Run container
# Bounded Context: Dashboards (read models) + custom_dashboards
# Build from the REPO ROOT: docker build -f services/dashboard/Dockerfile .
# (it reuses the monolith's lib/ helpers rather than copying them).

FROM node:22-slim

WORKDIR /app

COPY services/dashboard/package.json ./package.json
RUN npm install --omit=dev

COPY lib/correlationId.js lib/internalCaller.js lib/routeGuards.js lib/geocodeLocation.js lib/piiCrypto.js lib/crypto.js lib/placeCoords.js lib/misCalculations.js ./lib/
COPY db/seed-data/lgd/place-coords.json.gz ./db/seed-data/lgd/
COPY services/dashboard/index.js ./services/dashboard/
COPY services/dashboard/src ./services/dashboard/src

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/dashboard/index.js"]
