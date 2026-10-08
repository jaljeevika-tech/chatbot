# FieldFlow HR Service — Cloud Run container
# Bounded Context: HR Management (DDD)
# Owns: hr_settings, hr_locations, hr_employee_profiles, hr_holidays,
#       hr_leave_types, hr_leave_requests, hr_attendance,
#       hr_attendance_corrections, hr_sync_receipts
# Build context is the REPO ROOT (reuses lib/serviceApp.js):
#   docker build -f services/hr/Dockerfile .

FROM node:22-slim

WORKDIR /app

COPY services/hr/package.json ./package.json
RUN npm install --omit=dev

COPY lib/serviceApp.js lib/internalCaller.js lib/correlationId.js ./lib/
COPY services/hr/*.js ./services/hr/

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "services/hr/index.js"]
