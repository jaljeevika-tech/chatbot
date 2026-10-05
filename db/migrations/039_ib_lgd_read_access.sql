-- db/migrations/039_ib_lgd_read_access.sql
--
-- Individual Beneficiary registration form now uses the same LGD (Local
-- Government Directory) State/District/Block/Panchayat/Village reference
-- data as the "+ New Project" form (see db/migrations/035_lgd_admin_divisions.sql,
-- routes/lgd.routes.js, src/components/dashboard/LocationPicker.tsx) instead
-- of unconstrained free text. The lgd_* tables are global reference data —
-- no org_id column, no RLS — so this is a plain read grant, no policy needed.

GRANT SELECT ON lgd_states, lgd_districts, lgd_blocks, lgd_panchayats, lgd_villages TO ib_service;
