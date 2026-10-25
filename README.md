# WarmSignal

**Be the person who always has something valuable to give.**

A relationship-intelligence briefing for Alonso (fractional CMO). Conversation notes go in; Claude extracts needs and offers with evidence; WarmSignal proposes introductions and scores them deterministically. Each morning it shows up to five opportunities to give.

```
Contacts CSV + notes → Claude extraction (needs/offers + quotes) → Supabase
  → Claude match validation (Give Value, confidence, appropriateness)
  → deterministic scoring in code (PRD §5) → briefing (≤5, one per recipient)
```

## Setup

```bash
npm install
cp .env.example .env.local      # Anthropic, Supabase (URL, anon, service role), Tavily, INVITE_CODE
# Apply the schema: supabase link --project-ref <ref> && supabase db push
npm run dev                     # http://localhost:3000 -> /signup with the invite code
```

**Accounts.** Email/password sign-up is gated by `INVITE_CODE` (checked server-side; the account is created with the admin API). Turn off **Allow new users to sign up** in Supabase → Authentication so the invite gate can't be bypassed. Each account has its own private network, enforced by Postgres RLS on `owner_id`.

**Demo data.** A new account starts empty. **Load demo contacts** (on the briefing page or the Contacts page) copies `data/demo_snapshot.json` into the account instantly: 30 fictional contacts with processed notes, intros and drafts, plus 5 real public figures who are web-enriched only and never introduced. **Remove demo contacts** deletes them again.

To regenerate the snapshot with the live pipeline (Claude extraction, Tavily enrichment, matching, drafts; about 2 minutes):

```bash
npm run seed -- --email you@example.com --reset --export
```

## Models

| Stage | Env var | Default |
|---|---|---|
| Note extraction | `ANTHROPIC_MODEL` | `claude-opus-5-5` |
| Intro matching (the judge) | `ANTHROPIC_MATCH_MODEL` | same as `ANTHROPIC_MODEL` |
| Web-enrichment summaries, intro and catch-up drafts | `ANTHROPIC_FAST_MODEL` | `claude-haiku-4-5` |

Any stage can run on Haiku 4.5. `src/lib/claude.ts` leaves out `effort` and the server-side fallback beta for Haiku, because Haiku doesn't accept them. To make Haiku the judge, set `ANTHROPIC_MATCH_MODEL=claude-haiku-4-5`. If you do, re-check the expected demo outcomes below, because matching enforces subtle rules (investment criteria, confidentiality, declined intro types).

## Where things live

| Concern | File |
|---|---|
| Claude extraction (Stage A) | `src/lib/extract.ts` |
| Candidate matching + validation (Stages B–C) | `src/lib/match.ts` |
| **Scoring weights, cooling curve, eligibility** | `src/lib/scoring.ts` |
| Briefing assembly, dedupe, next action | `src/lib/briefing.ts` |
| Outreach drafts (FR-08) | `src/lib/draft.ts` |
| Schema | `supabase/migrations/` |
| Sample data | `data/contacts.csv`, `data/notes.json` |

## Design decisions

- **Scores are never stored.** Claude's per-pair assessments (Give Value 0–5, timeliness 0–5, match confidence) are stored. The weighted score is recomputed in code from those values and an evaluation date. Set `DEMO_EVAL_DATE` (or use `?date=` on the briefing) and the results are reproducible.
- **Eligibility comes before ranking.** Give Value must be at least 3/5. Candidates are also dropped if they're flagged inappropriate, the need is expired or stale (>270 days), the need is an inference backed by weak evidence, or the candidate was dismissed, deferred, or handled. Filtered candidates appear on the briefing page with the reason, so you can show FR-07 working.
- **Facts vs. assumptions.** Each need or offer carries a verbatim quote, an `is_inferred` flag, and `quote_verified` (we check that the quote really appears in the note). Inferred needs have their Match Confidence capped.
- **Consent first.** The suggested action always asks the recipient first, then the proposed contact. Nothing is ever sent automatically.
- **Web enrichment stays fresh.** New contacts are enriched with Tavily in the background as soon as they're created or imported. A daily Vercel Cron job (`/api/cron/enrich`, protected by `CRON_SECRET`) re-enriches any contact last checked more than 14 days ago, so each contact is refreshed about every two weeks. Company news prefers reputable outlets and press wires. A refresh that can't confirm identity keeps the last good match, and fictional demo contacts are never searched on a schedule.
- **Privacy.** Each user's rows are protected by RLS (`owner_id = auth.uid()`), and requests use the user's session. The service-role key is used only for scripts, background enrichment and creating accounts. Only name, title and company are sent to Tavily.

## Expected demo outcomes (sample data, eval date 2026-10-25)

Strong: Sarah ← Michael (healthcare seed investor), Sarah ← Priya (enterprise health sales advisor), Grace ↔ Tom (routing software buyer/vendor), Olivia ↔ Ben (B2B podcast), David ← Elena (VP Eng, confidential, so it must be permission-first).
Should *not* surface: Sarah ← Hannah (Series A+ only), James (the need belongs to his friend), Marcus (no stated need), Kevin (stale), Rachel (mass-intro request), Tom ← any investor (he declined investor intros).

## Team

- Will Zhao ([@WillZhao2021](https://github.com/WillZhao2021))
- Mark ([@MarkUnivWash](https://github.com/MarkUnivWash))
