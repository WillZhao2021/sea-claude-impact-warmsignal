-- Retrieval for matching at scale and profile fit (src/lib/vectors.ts).
-- One searchable document per contact describing who they are and what they can give
-- (title, company, recorded offers, public-web summary). Needs are deliberately left out:
-- a document answers "who could help with X", and a need for X would match the wrong way.
create extension if not exists vector with schema extensions;

create table contact_documents (
  contact_id text primary key references contacts(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content text not null,
  content_hash text not null, -- re-embed only when the content changes
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  embedding extensions.vector(384) not null, -- Supabase gte-small, normalized
  updated_at timestamptz not null default now()
);
create index on contact_documents (owner_id);
create index on contact_documents using gin (fts);
create index on contact_documents using hnsw (embedding extensions.vector_cosine_ops);

alter table contact_documents enable row level security;
create policy "owner only" on contact_documents for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Hybrid search: semantic (cosine) and keyword (full-text) rankings merged by reciprocal rank fusion.
-- keywords is an OR query for websearch_to_tsquery ("pricing or saas or churn"). Owner is explicit
-- so the function is also safe from the service client; security invoker keeps RLS for users.
create function match_contact_documents(
  p_owner uuid,
  query_embedding extensions.vector(384),
  keywords text,
  match_count int default 15,
  exclude_ids text[] default '{}'
)
returns table (contact_id text, score double precision)
language sql stable security invoker set search_path = public, extensions
as $$
  with semantic as (
    select d.contact_id, row_number() over (order by d.embedding <=> query_embedding) as rank
    from contact_documents d
    where d.owner_id = p_owner and not (d.contact_id = any (exclude_ids))
    order by d.embedding <=> query_embedding
    limit match_count * 2
  ),
  keyword as (
    select d.contact_id,
      row_number() over (order by ts_rank_cd(d.fts, websearch_to_tsquery('english', keywords)) desc) as rank
    from contact_documents d
    where d.owner_id = p_owner and not (d.contact_id = any (exclude_ids))
      and d.fts @@ websearch_to_tsquery('english', keywords)
    order by ts_rank_cd(d.fts, websearch_to_tsquery('english', keywords)) desc
    limit match_count * 2
  )
  select coalesce(s.contact_id, k.contact_id) as contact_id,
    coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score
  from semantic s full outer join keyword k on s.contact_id = k.contact_id
  order by score desc
  limit match_count;
$$;

-- Profile fit: the user's ideal-client terms (each industry and role from onboarding), embedded
-- once when the profile changes so ranking never calls the embedding model during render.
create table profile_fit_terms (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('industry', 'role')),
  label text not null,
  embedding extensions.vector(384) not null,
  primary key (owner_id, kind, label)
);
alter table profile_fit_terms enable row level security;
create policy "owner only" on profile_fit_terms for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- For each contact, the ideal-client term its document is most similar to (one query for the whole network).
create function profile_fit(p_owner uuid)
returns table (contact_id text, kind text, label text, similarity double precision)
language sql stable security invoker set search_path = public, extensions
as $$
  select distinct on (d.contact_id) d.contact_id, t.kind, t.label, 1 - (d.embedding <=> t.embedding)
  from contact_documents d
  join profile_fit_terms t on t.owner_id = d.owner_id
  where d.owner_id = p_owner
  order by d.contact_id, d.embedding <=> t.embedding, t.kind, t.label;
$$;
