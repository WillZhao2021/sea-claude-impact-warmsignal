-- Give / Ask: a third catch-up draft mode, "ask", for Today's Ask cards: one clear, low-pressure ask.
-- A send counts against the weekly ask budget only when the draft sent was written in this mode.
alter table contacts drop constraint if exists contacts_outreach_draft_mode_check;
alter table contacts add constraint contacts_outreach_draft_mode_check
  check (outreach_draft_mode in ('keep_warm', 'reconnect', 'ask'));
