-- Two chat threads per user: "onboarding" (/onboarding, one-time setup by conversation) and
-- "main" (/chat, filling in the network). Existing messages belong to the main thread.
-- Until this is applied the app treats all messages as one thread (src/lib/chat/agent.ts).
alter table chat_messages add column if not exists thread text not null default 'main'
  check (thread in ('main', 'onboarding'));
create index if not exists chat_messages_owner_thread_created_idx on chat_messages (owner_id, thread, created_at);
