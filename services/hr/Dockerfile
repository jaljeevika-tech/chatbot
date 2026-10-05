# FieldFlow HR Service — Cloud Run container
# Bounded Context: HR Management (DDD)
# Owns: hr_settings, hr_locations, hr_employee_profiles, hr_holidays,
#       hr_leave_types, hr_leave_requests, hr_attendance,
#       hr_attendance_corrections, hr_sync_receipts

FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY *.js ./

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "index.js"]
