-- Activity log: one row per outreach action, so the briefing can show a network score and a daily streak.
-- Contact/opportunity links are informational; history survives their deletion.
create table activity (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('catch_up_sent', 'intro_step', 'note_logged')),
  detail text,                                -- e.g. the intro step: recipient_yes, proposed_yes, intro_sent, declined
  contact_id text references contacts(id) on delete set null,
  opportunity_id uuid references opportunities(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on activity (owner_id, date);

alter table activity enable row level security;
create policy "owner only" on activity for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Backfill catch-ups already sent from the deck.
insert into activity (owner_id, date, kind, contact_id)
select owner_id, last_outreach_at, 'catch_up_sent', id from contacts where last_outreach_at is not null;
