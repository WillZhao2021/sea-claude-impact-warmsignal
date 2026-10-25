-- Catch-up drafts now come in two modes: "keep_warm" (the /catch-up deck: no-agenda check-ins)
-- and "reconnect" (Today: can mention a reason). The cached draft records which mode wrote it,
-- so one mode never serves the other's draft. Existing drafts have no mode and regenerate.
alter table contacts add column outreach_draft_mode text check (outreach_draft_mode in ('keep_warm', 'reconnect'));
