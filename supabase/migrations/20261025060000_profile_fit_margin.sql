-- Profile fit, calibrated per term. gte-small's baseline similarity differs by term (on the demo
-- network the median is 0.76 for "Healthcare" but 0.80 for "Venture capital"), so a fixed
-- threshold favors some industries. Fit is now the margin above the term's median across the
-- user's own contacts; src/lib/vectors.ts turns the margin into a 0–1 score.
drop function if exists profile_fit(uuid);

create function profile_fit(p_owner uuid)
returns table (contact_id text, kind text, label text, similarity double precision, margin double precision)
language sql stable security invoker set search_path = public, extensions
as $$
  with sims as (
    select d.contact_id, t.kind, t.label, 1 - (d.embedding <=> t.embedding) as similarity
    from contact_documents d
    join profile_fit_terms t on t.owner_id = d.owner_id
    where d.owner_id = p_owner
  ),
  medians as (
    select kind, label, percentile_cont(0.5) within group (order by similarity) as median
    from sims
    group by kind, label
  ),
  scored as (
    select s.*, s.similarity - m.median as margin
    from sims s
    join medians m using (kind, label)
  )
  select distinct on (contact_id) contact_id, kind, label, similarity, margin
  from scored
  order by contact_id, margin desc, kind, label;
$$;
