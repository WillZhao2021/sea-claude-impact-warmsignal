-- Onboarding answers: what the user offers, their goal, ideal clients and outreach rhythm.
-- One row per user; RLS restricts it to its owner.
create table profiles (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  offers text[] not null default '{}',
  offer_line text,
  goal text check (goal in ('clients', 'referrals', 'winback', 'give', 'partners')),
  industries text[] not null default '{}',
  roles text[] not null default '{}',
  revenue text[] not null default '{any}',
  per_day smallint not null default 5 check (per_day between 1 and 10),
  asks_per_week smallint not null default 2 check (asks_per_week between 0 and 5),
  gives_per_ask smallint not null default 2 check (gives_per_ask between 0 and 5),
  rest_days smallint not null default 14 check (rest_days between 1 and 90),
  tone text not null default 'warm' check (tone in ('warm', 'professional', 'brief')),
  onboarded_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "owner only" on profiles for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
