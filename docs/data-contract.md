# Contact data contract

This file lists everything Daily Networker stores about a person in a user's network, along with where each item comes from, who writes it, how fresh it stays, and where it is allowed to go. Each user's rows belong to that user (`owner_id`) and are protected by RLS.

Status: ✅ = implemented · 🆕 = proposed, not yet implemented

## Rules that apply to every field

1. **Sources stay separate.** Facts the user told us (notes, swipes) are kept apart from public-web facts (enrichment). Web facts are always labeled unverified and never count as a stated need or offer.
2. **Contact details stay inside the app.** `phone` and `email` are never sent to Claude or Tavily. They're used only to build the user's own send links (`wa.me`, `sms:`, `mailto:`).
3. **Only these fields go to Tavily:** `name`, `title`, `company`, `industry`, `linkedin_url`. Note contents never go to Tavily.
4. **No personal-life data.** We don't collect family, home address, personal social accounts, photos, health, religion, or politics, even when they're public. Outreach should read as relevant, not researched.
5. **Nothing is sent automatically.** Drafts are suggestions, and the user sends every message themselves.
6. **Deleting is a cascade.** Deleting a contact removes their interactions, signals, opportunities and enrichment.

## 1. `contacts`: one row per person

### Identity

| Field | Type | Req | Status | Source | Notes |
|---|---|---|---|---|---|
| `id` | text (uuid) | ✔ | ✅ | generated | Internal key |
| `owner_id` | uuid | ✔ | ✅ | auth | RLS scope |
| `external_id` | text | | ✅ | import | Unique per owner. **For LinkedIn imports, use the normalized `linkedin_url`** so re-uploads update existing rows |
| `name` | text | ✔ | ✅ | import / user | |
| `linkedin_url` | text | | 🆕 | LinkedIn export | Lowercase, no trailing slash. Main identity anchor for enrichment |
| `email` | text | | ✅ | LinkedIn export (only when the connection shares it) / vCard | **Private**: never sent to an LLM or Tavily |
| `phone` | text (E.164) | | ✅ | vCard / Contact Picker / typed on the card | **Private**: only used for `wa.me/<phone>` and `sms:`. If missing, fall back to `wa.me/?text=` |
| `source` | text[] | | 🆕 | import | Any of `linkedin_export`, `vcard`, `manual`, `demo` |

### Professional profile

| Field | Type | Req | Status | Source | Refresh |
|---|---|---|---|---|---|
| `company` | text | | ✅ | LinkedIn export, user edit wins | On each re-upload |
| `title` | text | | ✅ | LinkedIn export ("Position") | On each re-upload |
| `industry` | text | | ✅ | user / Claude guess from title + company | Rarely |
| `location` | text | | 🆕 | user / enrichment | Metro area only (e.g. "Seattle, WA"), never an address |
| `profile_history` | jsonb `[{company, title, seen_at}]` | | 🆕 | written by the import diff | Appended when company or title changes. **A change creates a "why now" signal** |

### Relationship (written by the user)

| Field | Type | Req | Status | Source | Notes |
|---|---|---|---|---|---|
| `relationship_strength` | smallint 1–5 | ✔ | ✅ | onboarding swipe, adjusted by follow-ups | up = 4–5, right = 3, down = 1–2. Below 2 is never proposed for intros |
| `last_interaction_date` | date | | ✅ | notes / follow-ups | Feeds the "cooling" score |
| `introduction_preferences` | text | | ✅ | user / extracted from notes | e.g. "No investor intros right now". Matching must respect it |
| `connected_on` | date | | 🆕 | LinkedIn export | Context only |

### Outreach state (the deck)

| Field | Type | Status | Notes |
|---|---|---|---|
| `last_outreach_at` | date | ✅ | When the user last reached out |
| `outreach_snoozed_until` | date | ✅ | Set by "not now" |
| `outreach_draft` | text | ✅ | Cached draft; cleared when the context changes |

### Public-web enrichment (Tavily + Claude)

| Field | Type | Status | Notes |
|---|---|---|---|
| `enrichment` | jsonb (`Enrichment` in `src/lib/types.ts`) | ✅ | `status`, `identity_confidence` (`high`/`medium` to keep), `summary`, `recent_signals[]`, `possible_offers[]`, `sources[]`. Every item has a `source_url` from the search results |
| `enriched_at` | timestamptz | ✅ | |
| refresh cadence | `REFRESH_AFTER_DAYS` in `src/lib/enrich.ts` | ✅ | Enriched on creation or import, then re-enriched by the daily cron (`/api/cron/enrich`) once older than **14 days**. Fictional demo contacts are skipped |

**Enrichment queries, in priority order** (person-name searches are mostly namesakes for private individuals):
1. `linkedin_url`, read directly to confirm identity (title, company, location).
2. **Company/team news from the past 30 days, limited to trusted sites** (the company's own newsroom, `aws.amazon.com/about-aws/whats-new`-style pages, TechCrunch, GeekWire, The Verge, Bloomberg). This is the main source of "why now" signals.
3. The person's public professional work: `"<name>" <company>` on GitHub, Medium, Substack, YouTube, conference sites.

If identity confidence is `low` or `none`, nothing is stored except `identity_notes`.

## 2. `interactions`: notes and meeting follow-ups ✅

| Field | Type | Notes |
|---|---|---|
| `contact_id`, `owner_id` | | |
| `date` | date | When the conversation happened |
| `raw_notes` | text | User-written. **Never sent to Tavily** |
| `context` | jsonb | Claude extraction output: `summary`, `uncertainties[]` (sensitivities, needs that belong to someone else) |
| `extracted_at` | timestamptz | |
| `kind` | text 🆕 | `note` · `onboarding_quick_note` · `meeting_followup` |
| `outcome` | text 🆕 | Follow-ups only: `positive` · `neutral` · `negative`. Labels for tuning the ranking later |
| `opportunity_id` | uuid 🆕 | Follow-ups only: the intro or catch-up this follow-up is about |

## 3. `signals`: needs and offers extracted from notes ✅

Each signal is linked to the interaction it came from. Key fields: `type` (`need`/`offer`), `description`, `supporting_text` (a **verbatim** quote), `quote_verified`, `is_inferred` (an inferred signal has confidence ≤0.5), `time_sensitive`, `confidence` 0–1, `status` (`active`/`stale`/`resolved`), `relevant_until`.

## 4. `opportunities`: suggested introductions ✅

Claude stores its assessment of each pair (`give_value` 0–5, `timeliness` 0–5, `match_confidence` 0–1, `appropriate`, `concerns`). **The priority score is never stored**; `src/lib/scoring.ts` recomputes it from these fields and the evaluation date. Consent goes `not_requested → pending → approved/declined`, and the status goes `suggested → useful/deferred/dismissed/completed`.

## Import mapping

**LinkedIn `Connections.csv`** → `contacts`

| LinkedIn column | Field |
|---|---|
| First Name + Last Name | `name` |
| URL | `linkedin_url`, `external_id` |
| Email Address | `email` (often empty) |
| Company | `company` |
| Position | `title` |
| Connected On | `connected_on` |

New contacts get `relationship_strength = 2` until the user sorts them in onboarding. On re-upload, a row matched by `external_id` updates `company`/`title`. A change is appended to `profile_history`, and fields the user edited by hand are not overwritten.

**vCard / Google Contacts CSV** (✅ `src/lib/phonebook.ts`, Contacts → Add phone numbers) → fills `phone` and `email` on existing contacts. Match on email first, then exact normalized name; ask the user when it's ambiguous. Contacts that aren't on LinkedIn are created with `source = vcard`.

## Example (demo record)

```json
{
  "external_id": "linkedin.com/in/will-zhao-770634152",
  "name": "Will Zhao",
  "linkedin_url": "https://www.linkedin.com/in/will-zhao-770634152",
  "email": null,
  "phone": null,
  "source": ["linkedin_export", "demo"],
  "company": "Amazon",
  "title": "Software Development Engineer II (Amazon Q)",
  "industry": "Generative AI",
  "location": "Seattle, WA",
  "relationship_strength": 4,
  "last_interaction_date": "2026-09-12",
  "introduction_preferences": "Open to meeting early-stage founders building on AWS",
  "enrichment": {
    "status": "matched",
    "identity_confidence": "high",
    "identity_notes": "LinkedIn URL matches name, Seattle location and Amazon Q role.",
    "summary": "Software engineer on Amazon Q in Seattle; WashU St. Louis alum.",
    "recent_signals": [
      {
        "kind": "launch",
        "text": "Amazon Q Developer added enhanced console visualizations",
        "date": "2026-10-01",
        "source_url": "https://aws.amazon.com/about-aws/whats-new/2026/10/..."
      }
    ],
    "possible_offers": [],
    "sources": [{ "title": "Will Zhao | LinkedIn", "url": "https://www.linkedin.com/in/will-zhao-770634152" }]
  }
}
```
