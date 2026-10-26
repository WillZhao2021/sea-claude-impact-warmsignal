# Daily Networker

**Be the person who always has something valuable to give.** Daily Networker turns a small business owner's network into a daily, two-minute habit: it tells you who to talk to today and why, drafts the message, and helps you either **make an intro** (give) or **ask for a meeting or an intro** (ask). Referrals follow from giving first.

## Try it now (no code, about 5 minutes)
1. Open **https://warmsignal-wheat.vercel.app** and sign up. Ask the team for the pilot invite code.
2. **Setup** (step-by-step): your name, what you offer, your goal (make intros or ask for intros), and your ideal clients.
3. **Upload contacts.** Use LinkedIn's official export (Settings → Data privacy → Get a copy of your data → Connections → upload `Connections.csv`), or any CSV. Optionally add an iPhone/Google address book (`.vcf` or Google CSV) to get WhatsApp buttons.
4. Open **Today**: up to 5 people to talk to, the reason for each, and a drafted message. Send it yourself through WhatsApp, email or LinkedIn.
5. Open **Chat**: it asks about people with missing information ("How do you know Will?"). Answer by tapping, typing, or the 🎙️ mic, and it looks people up on the web for you.

No demo data of your own? Click **Load demo contacts** to explore a ready-made 35-person network.

## Who it helps, and how
- **Who:** consultants, fractional executives, agencies, and any owner whose new business comes from referrals and warm intros.
- **The problem:** the network lives in their head and in LinkedIn. Follow-ups slip, and "let's stay in touch" never happens.
- **What changes:** instead of a CRM nobody updates, the owner gets a ranked daily list with reasons and drafts. Notes go in by voice in seconds, and the app keeps profiles fresh from the public web every two weeks.

## What's different
- **Give before you ask.** It finds introductions you can make (matching one contact's need to another's offer, with evidence quotes) and paces your asks behind your gives.
- **Explainable ranking.** Claude assesses, and code scores deterministically. Every card shows why the person is there.
- **Enrichment by conversation.** The chat asks you the one question that most improves your data. Voice notes are dictated in the browser, and no audio is stored.
- **Privacy by design.** Phone numbers and emails never go to Claude or the web search, and nothing is sent automatically. See `docs/data-contract.md`.

## Team
- **Will Zhao** ([@WillZhao2021](https://github.com/WillZhao2021)): product and core app. Notes → needs/offers extraction, intro matching and scoring, Today and Keep-warm ranking, Give/Ask moves, onboarding wizard, auth, vector search, landing page.
- **Mark** ([@MarkUnivWash](https://github.com/MarkUnivWash)): chat assistant (Haiku + tools, gap review, batch enrichment), voice notes, phone/email import and WhatsApp links, 14-day Tavily refresh, per-stage models (Haiku), the data contract, rename to Daily Networker.
- We worked through PRs on one repo, rebasing on each other's changes. See the merged PRs for who built what.

---

## Developer notes

A relationship-intelligence briefing for Alonso (fractional CMO). Conversation notes go in; Claude extracts needs and offers with evidence; Daily Networker proposes introductions and scores them deterministically. Each morning it shows up to five opportunities to give.

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

## Chat

`/chat` is the first screen. You talk with Haiku (`ANTHROPIC_CHAT_MODEL`, which defaults to `ANTHROPIC_FAST_MODEL`), and it uses Daily Networker's tools:
- **Your network:** show today's people, search, look someone up, add or update a contact
- **Notes:** save a note, which Claude reads for needs and offers
- **Web enrichment:** search Tavily for a contact
- **Drafts:** write a message, with a WhatsApp button

Results appear as cards in the conversation.

**Onboarding happens in the chat, once.** The assistant asks:
1. Your name and what you offer
2. Your goal and ideal clients
3. Your LinkedIn `Connections.csv`
4. Your phone contacts (vCard or Google CSV), for WhatsApp

Then it finishes setup and shows Today. You can drop files into the chat at any time with the paperclip.

The conversation is stored append-only in `chat_messages`. Phone numbers and emails only ever appear in cards, never in what Claude sees. The old form-based onboarding at `/onboarding` still works.

## Where things live

| Concern | File |
|---|---|
| Claude extraction (Stage A) | `src/lib/extract.ts` |
| Candidate matching + validation (Stages B–C) | `src/lib/match.ts` |
| **Scoring weights, cooling curve, eligibility** | `src/lib/scoring.ts` |
| Briefing assembly, dedupe, next action | `src/lib/briefing.ts` |
| Outreach drafts (FR-08) | `src/lib/draft.ts` |
| **Chat** (Haiku + tools; onboarding, uploads, cards) | `src/lib/chat/`, `src/app/api/chat/route.ts`, `src/components/chat/chat.tsx` |
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
