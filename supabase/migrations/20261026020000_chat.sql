-- Chat with WarmSignal (src/lib/chat): the conversation, append-only, one thread per user.
-- `content` is the Anthropic message content (text, tool_use, or tool_result blocks), replayed as
-- history on each turn. `cards` are what tool calls rendered in the UI (people, contact, draft,
-- upload prompts). Cards may include phone numbers for WhatsApp links; `content` never does.
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  cards jsonb not null default '[]',
  created_at timestamptz not null default clock_timestamp()
);
create index on chat_messages (owner_id, created_at);

alter table chat_messages enable row level security;
create policy "owner only" on chat_messages for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
