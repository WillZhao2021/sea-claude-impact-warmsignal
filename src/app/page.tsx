import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Suspense } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  PenLine,
  Gift,
  HandHelping,
  HeartHandshake,
  Hourglass,
  Repeat,
  Target,
  Zap,
  Filter,
  Flame,
  Layers,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import {
  advanceAction,
  findIntroductionsAction,
  loadDemoAction,
  reconnectDecisionAction,
  reconnectRedraftAction,
  redraftAction,
  setEvalDateAction,
  setStatusAction,
} from "@/app/actions";
import { DraftBox } from "@/components/draft-box";
import { SubmitButton } from "@/components/submit-button";
import { Avatar, btn, card, Chip, Logo, MoveTag, PageHeader } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { defaultEvalDate, type Candidate } from "@/lib/briefing";
import { getOrCreateCatchUpDraft } from "@/lib/catch-up";
import { draftKindFor, getOrCreateDraft } from "@/lib/draft";
import { buildMomentum, CONSISTENCY_WINDOW, GIVING_WINDOW, WARM_DAYS, type Momentum } from "@/lib/momentum";
import { getProfile } from "@/lib/profile";
import { WEIGHTS } from "@/lib/scoring";
import { serviceCtx } from "@/lib/supabase";
import { syncContactDocuments } from "@/lib/vectors";
import { buildToday, FACTOR_LABELS, type FactorKey, type ReasonKind, type TodayPerson } from "@/lib/today";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function BriefingPage({ searchParams }: PageProps<"/">) {
  const { date } = await searchParams;
  const evalDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : defaultEvalDate();
  const ctx = await requireCtx();
  // Setup is the onboarding wizard (/onboarding); Today needs a profile to rank against.
  if (!(await getProfile(ctx))?.onboarded_at) redirect("/onboarding");
  const { count: contactCount } = await ctx.db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ctx.ownerId);
  if (!contactCount) return <Welcome />;

  const [today, momentum] = await Promise.all([buildToday(ctx, evalDate), buildMomentum(ctx, evalDate)]);
  // Keep contact embeddings current for semantic fit (a no-op when nothing changed).
  const bg = serviceCtx(ctx.ownerId);
  after(() => syncContactDocuments(bg).catch((e) => console.error("syncContactDocuments failed:", e)));
  const { briefing } = today;
  const n = today.people.length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={new Date(evalDate + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        })}
        title={n === 0 ? "No one to reach out to today" : `Talk with ${n} ${n === 1 ? "person" : "people"} today`}
        subtitle="Each has a reason to hear from you: an intro you can make, a relationship cooling off, or something timely."
        actions={
          <>
            <form action={setEvalDateAction} className="flex items-center rounded-lg border border-slate-200 bg-white/80 shadow-sm backdrop-blur">
              <input
                type="date"
                name="date"
                defaultValue={evalDate}
                aria-label="Briefing date"
                className="bg-transparent py-2 pl-3 pr-1 text-sm text-slate-700 outline-none"
              />
              <SubmitButton className="!rounded-l-none border-l border-slate-200 !px-3 text-slate-600 hover:bg-slate-50">
                Go
              </SubmitButton>
            </form>
            <form action={findIntroductionsAction}>
              <input type="hidden" name="eval_date" value={evalDate} />
              <SubmitButton pendingText="Claude is reviewing your network…" className={btn.primary}>
                <Sparkles className="size-4" /> Refresh
              </SubmitButton>
            </form>
          </>
        }
      />

      {!today.profile?.full_name && (
        <Link
          href="/me"
          className={`${card} flex items-center gap-3 px-5 py-3.5 text-sm transition hover:shadow-card-lg`}
        >
          <PenLine className="size-4 shrink-0 text-ink-600" />
          <span className="flex-1 text-slate-700">
            <span className="font-semibold text-slate-900">Add your name</span> so drafted messages are signed by you.
          </span>
          <ArrowRight className="size-4 text-slate-400" />
        </Link>
      )}

      <MomentumCard
        m={momentum}
        perDay={today.profile?.per_day ?? null}
        keepWarmHref={evalDate === defaultEvalDate() ? "/catch-up" : `/catch-up?date=${evalDate}`}
      />

      {n === 0 && (
        <div className={`${card} flex flex-col items-center px-6 py-14 text-center`}>
          <div className="flex size-14 items-center justify-center rounded-2xl bg-ink-50 text-ink-600">
            <Sparkles className="size-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">Nothing pressing today</h2>
          <p className="mt-1 max-w-md text-sm text-slate-500">
            That&apos;s fine: Daily Networker never pads the list. Log new conversations on the Contacts page, then click{" "}
            <span className="font-medium text-slate-700">Refresh</span>.
          </p>
        </div>
      )}

      <ol className="space-y-4">
        {today.people.map((person, i) => (
          <PersonCard key={person.contact.id} rank={i + 1} person={person} evalDate={evalDate} />
        ))}
      </ol>

      {(today.more.length > 0 || briefing.filteredOut.length > 0) && (
        <div className="grid gap-4 pt-2 md:grid-cols-2">
          {today.more.length > 0 && (
            <Disclosure
              icon={<Layers className="size-4" />}
              title={`More people worth a note (${today.more.length})`}
              hint="Had a reason, but ranked below today's cut"
            >
              <ul className="divide-y divide-slate-100">
                {today.more.map((m) => (
                  <li key={m.contact.id} className="flex items-center justify-between gap-4 py-2.5">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <Link href={`/contacts/${m.contact.id}`} className="font-medium text-slate-800 hover:text-ink-700">
                          {m.contact.name}
                        </Link>
                        <MoveTag move={m.move} />
                      </span>
                      <span className="block truncate text-slate-500">{m.reasons.map((r) => r.title).join(" · ")}</span>
                    </span>
                    <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                      {Math.round(m.score)}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {briefing.filteredOut.length > 0 && (
            <Disclosure
              icon={<Filter className="size-4" />}
              title={`Intros we held back (${briefing.filteredOut.length})`}
              hint="Why these introductions weren't suggested"
            >
              <ul className="divide-y divide-slate-100">
                {briefing.filteredOut.map((c) => (
                  <li key={c.opp.id} className="py-2.5">
                    <div className="font-medium text-slate-800">
                      {c.recipient.name} <ArrowLeftRight className="inline size-3 text-slate-400" /> {c.proposed.name}
                    </div>
                    <div className="text-slate-500">{c.need.description}</div>
                    <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-700">
                      <CircleAlert className="mt-px size-3.5 shrink-0" /> {c.excludedReason}
                    </div>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
}

/** Network score (warmth, consistency, giving) and the daily outreach streak. */
function MomentumCard({ m, perDay, keepWarmHref }: { m: Momentum; perDay: number | null; keepWarmHref: string }) {
  const factors = [
    ["Warmth", m.warmth, `${m.warmCount} of ${m.coreCount} close contacts in the last ${WARM_DAYS}d`],
    ["Consistency", m.consistency, `active ${m.activeDays} of the last ${CONSISTENCY_WINDOW} days`],
    ["Giving", m.giving, `${m.introSteps} intro ${m.introSteps === 1 ? "step" : "steps"} in ${GIVING_WINDOW}d`],
  ] as const;
  const cold = m.coreCount - m.warmCount;
  const tip = {
    warmth: `${cold} close ${cold === 1 ? "contact has" : "contacts have"} gone quiet. A short check-in brings them back.`,
    consistency: "A little every day beats a burst: reach out to one person below.",
    giving: "Move an introduction forward below. Giving is what people remember.",
  }[m.focus];
  const todayCount = m.recent.at(-1)?.count ?? 0;
  const streakNote = m.activeToday
    ? perDay && todayCount < perDay
      ? `${todayCount} of ${perDay} today`
      : `Done for today${m.longestStreak > m.streak ? ` · best ${m.longestStreak}` : ""}`
    : m.streak > 0
      ? "Reach out today to keep it going"
      : "Reach out to someone today to start one";

  return (
    <section
      aria-label="Network momentum"
      className={`${card} grid animate-rise items-center gap-6 px-5 py-5 sm:px-6 md:grid-cols-[auto_1fr_auto]`}
    >
      <div className="flex items-center gap-4">
        <ScoreRing score={m.score} />
        <div className="md:hidden">
          <p className="font-semibold text-slate-900">Network score</p>
          <p className="text-sm text-slate-500">out of 100</p>
        </div>
      </div>

      <div className="min-w-0 space-y-2.5">
        <p className="hidden text-xs font-semibold uppercase tracking-wider text-ink-600 md:block">Network score</p>
        <ul className="space-y-2 text-xs">
          {factors.map(([label, value, note]) => (
            <li key={label} className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[5.5rem_8rem_1fr]">
              <span className="font-medium text-slate-700">{label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full bg-ink-500" style={{ width: `${Math.max(value * 100, 2)}%` }} />
              </span>
              <span className="col-start-2 truncate text-slate-500 sm:col-start-auto">{note}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-slate-600">
          {tip}
          {m.focus === "warmth" && (
            <>
              {" "}
              <Link href={keepWarmHref} className="font-medium text-ink-600 hover:text-ink-800">
                Open Keep warm →
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="border-t border-slate-100 pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
        <div className="flex items-center gap-3">
          <span
            className={`flex size-11 items-center justify-center rounded-xl ${
              m.activeToday ? "bg-amber-50 text-amber-500" : "bg-slate-100 text-slate-400"
            }`}
          >
            <Flame className="size-6" fill={m.activeToday ? "currentColor" : "none"} />
          </span>
          <div>
            <p className="font-bold text-slate-950">
              {m.streak > 0 ? (
                <>
                  <span className="text-2xl">{m.streak}</span>-day streak
                </>
              ) : (
                <span className="text-lg">No streak yet</span>
              )}
            </p>
            <p className="text-xs text-slate-500">{streakNote}</p>
          </div>
        </div>
        <ol className="mt-3 flex gap-1" aria-label={`Outreach in the last ${CONSISTENCY_WINDOW} days`}>
          {m.recent.map((d, i) => {
            const label = new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
            return (
              <li
                key={d.date}
                title={`${label}: ${d.count ? `${d.count} ${d.count === 1 ? "action" : "actions"}` : "no outreach"}`}
                className={`size-3.5 rounded-[4px] ${d.count ? "bg-ink-500" : "bg-slate-100"} ${
                  i === m.recent.length - 1 ? "ring-2 ring-ink-200 ring-offset-1" : ""
                }`}
              />
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex size-20 shrink-0 items-center justify-center">
      <svg viewBox="0 0 76 76" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="7" className="stroke-slate-100" />
        <circle
          cx="38"
          cy="38"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          className="stroke-ink-600"
        />
      </svg>
      <span className="text-2xl font-bold tracking-tight text-slate-950" aria-label={`Network score ${score} out of 100`}>
        {score}
      </span>
    </span>
  );
}

function Disclosure({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <details className={`group ${card} self-start`}>
      <summary className="flex cursor-pointer items-center gap-3 px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">{icon}</span>
        <span className="flex-1">
          <span className="block text-sm font-semibold text-slate-800">{title}</span>
          <span className="block text-xs text-slate-500">{hint}</span>
        </span>
        <ChevronDown className="size-4 text-slate-400 transition group-open:rotate-180" />
      </summary>
      <div className="border-t border-slate-100 px-5 pb-3 text-sm">{children}</div>
    </details>
  );
}

const first = (name: string) => name.split(" ")[0];

/** Removes sentences that cite internal matching refs (N12, P3…) from older model output. */
const clean = (text: string | null) =>
  text
    ?.split(/(?<=[.;!?])\s+/)
    .filter((sentence) => !/\b[NOP]\d+\b/.test(sentence))
    .join(" ")
    .trim() || null;

const REASON_STYLE: Record<ReasonKind, { icon: React.ReactNode; tone: string }> = {
  give: { icon: <Gift className="size-4" />, tone: "bg-violet-50 text-violet-700 ring-violet-200/70" },
  loop: { icon: <Repeat className="size-4" />, tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/70" },
  cooling: { icon: <Hourglass className="size-4" />, tone: "bg-sky-50 text-sky-700 ring-sky-200/70" },
  timing: { icon: <Zap className="size-4" />, tone: "bg-amber-50 text-amber-700 ring-amber-200/70" },
  fit: { icon: <Target className="size-4" />, tone: "bg-indigo-50 text-indigo-700 ring-indigo-200/70" },
  ask: { icon: <HandHelping className="size-4" />, tone: "bg-teal-50 text-teal-700 ring-teal-200/70" },
  relationship: { icon: <HeartHandshake className="size-4" />, tone: "bg-rose-50 text-rose-700 ring-rose-200/70" },
};

/** One person to talk with today: why (several reasons), then the single best next step. */
function PersonCard({ rank, person, evalDate }: { rank: number; person: TodayPerson; evalDate: string }) {
  const c = person.contact;
  const name = first(c.name);
  // Lead with the intro flow when an intro is the strongest reason (or one is already under way).
  const top = person.reasons[0]?.kind;
  const leadWithIntro = person.intro && (top === "give" || top === "loop" || person.factors.loop > 0);

  return (
    <li className="animate-rise" style={{ animationDelay: `${(rank - 1) * 70}ms` }}>
      <details name="today" open={rank === 1} className={`group ${card} transition hover:shadow-card-lg open:shadow-card-lg`}>
        <summary className="flex cursor-pointer items-center gap-4 px-5 py-4 sm:px-6">
          <Avatar name={c.name} />
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-bold tracking-tight text-slate-950 group-open:text-xl">Talk with {c.name}</span>
            <span className="block truncate text-sm text-slate-500">{[c.title, c.company].filter(Boolean).join(" · ")}</span>
            <span className="mt-1.5 flex">
              <MoveTag move={person.move} withWhy />
            </span>
            <span className="mt-2 flex flex-wrap gap-1.5 group-open:hidden">
              {person.reasons.slice(0, 3).map((r) => (
                <span key={r.kind + r.title} className={`inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${REASON_STYLE[r.kind].tone}`}>
                  {REASON_STYLE[r.kind].icon}
                  <span className="truncate">{FACTOR_LABELS[r.kind]}</span>
                </span>
              ))}
            </span>
          </span>
          <ScorePill score={person.score} />
          <ChevronDown className="size-5 shrink-0 text-slate-400 transition group-open:rotate-180" />
        </summary>

        <div className="space-y-6 px-5 pb-6 sm:px-6">
          <section>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-600">Why today</p>
            <ul className="space-y-3">
              {person.reasons.map((r) => (
                <li key={r.kind + r.title} className="flex items-start gap-3">
                  <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${REASON_STYLE[r.kind].tone}`}>
                    {REASON_STYLE[r.kind].icon}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-semibold text-slate-900">{r.title}</span>
                    {r.detail && <span className="block text-slate-600">{r.detail}</span>}
                    {r.source &&
                      (r.source.url ? (
                        <a href={r.source.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-600 hover:underline">
                          <ExternalLink className="size-3" /> {r.source.label}
                        </a>
                      ) : (
                        <span className="mt-0.5 block text-xs italic text-slate-400">{r.source.label}</span>
                      ))}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-slate-400">+{r.points.toFixed(0)}</span>
                </li>
              ))}
            </ul>
          </section>

          {leadWithIntro && person.intro ? (
            <IntroAction c={person.intro} evalDate={evalDate} />
          ) : (
            <ReconnectAction person={person} evalDate={evalDate} />
          )}
          {!leadWithIntro && person.intro && (
            <details className="group/intro rounded-xl border border-slate-100 px-4 py-3">
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
                <Gift className="size-4 text-violet-500" /> Also: introduce {name} to {person.intro.proposed.name}
                <ChevronDown className="ml-auto size-4 transition group-open/intro:rotate-180" />
              </summary>
              <div className="mt-4">
                <IntroAction c={person.intro} evalDate={evalDate} />
              </div>
            </details>
          )}

          <details className="group/score">
            <summary className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
              <ChevronDown className="size-4 transition group-open/score:rotate-180" /> How {name} ranked today
            </summary>
            <div className="mt-4 max-w-md">
              <TodayBreakdown person={person} />
            </div>
          </details>
        </div>
      </details>
    </li>
  );
}

/** Reach out to reconnect: a meet-up message drafted from the reasons above. */
function ReconnectAction({ person, evalDate }: { person: TodayPerson; evalDate: string }) {
  const c = person.contact;
  const name = first(c.name);
  // An Ask card gets an ask-mode draft; sending it spends one of this week's asks.
  const askFor = person.move.kind === "ask" ? person.move.why : undefined;
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 sm:p-5">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">Next step</p>
        <p className="font-semibold text-slate-900">
          {askFor ? `Ask ${name} for one thing` : `Reach out to ${name} and suggest a catch-up`}
        </p>
        {askFor && <p className="text-sm text-slate-500">{askFor}. Keep it to a single, easy-to-decline ask.</p>}
      </div>
      <Suspense fallback={<DraftSkeleton />}>
        <ReconnectDraft contactId={c.id} evalDate={evalDate} askFor={askFor} label={`To ${name}`} />
      </Suspense>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <form action={reconnectDecisionAction} className="flex gap-2">
          <input type="hidden" name="contact_id" value={c.id} />
          <input type="hidden" name="eval_date" value={evalDate} />
          <SubmitButton name="decision" value="sent" pendingText="Saving…" className={btn.primary}>
            <Send className="size-4" /> Mark as sent
          </SubmitButton>
          <SubmitButton name="decision" value="snooze" pendingText="Saving…" className={btn.secondary}>
            Not now (14d)
          </SubmitButton>
        </form>
        <form action={reconnectRedraftAction}>
          <input type="hidden" name="contact_id" value={c.id} />
          {askFor && <input type="hidden" name="ask_for" value={askFor} />}
          <input type="hidden" name="eval_date" value={evalDate} />
          <SubmitButton pendingText="Redrafting…" className={btn.ghost}>
            <RefreshCw className="size-3.5" /> Redraft
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

async function ReconnectDraft({
  contactId,
  evalDate,
  askFor,
  label,
}: {
  contactId: string;
  evalDate: string;
  askFor?: string;
  label: string;
}) {
  const ctx = await requireCtx();
  const result = await getOrCreateCatchUpDraft(ctx, contactId, evalDate, false, askFor ? "ask" : "reconnect", askFor).then(
    (draft) => ({ draft, error: null }),
    (e: Error) => ({ draft: null, error: e.message }),
  );
  if (result.draft == null) {
    return <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t draft a message: {result.error}</p>;
  }
  return <DraftBox key={result.draft} draft={result.draft} label={label} />;
}

const TODAY_COLORS: Record<FactorKey, string> = {
  give: "bg-violet-500",
  loop: "bg-emerald-500",
  cooling: "bg-sky-400",
  timing: "bg-amber-400",
  fit: "bg-indigo-400",
  ask: "bg-teal-400",
  relationship: "bg-rose-300",
};

function TodayBreakdown({ person }: { person: TodayPerson }) {
  const keys = (Object.keys(person.factors) as FactorKey[]).sort(
    (a, b) => person.weights[b] * person.factors[b] - person.weights[a] * person.factors[a],
  );
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-800">Today score</span>
        <span className="text-sm font-semibold text-slate-900">
          {person.score} <span className="font-normal text-slate-400">/ 100</span>
        </span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {keys.map((k) => (
          <div key={k} className={`${TODAY_COLORS[k]} border-r border-white last:border-0`} style={{ width: `${person.weights[k] * person.factors[k] * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs">
        {keys.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${TODAY_COLORS[k]}`} />
            <span className="w-40 text-slate-700">{FACTOR_LABELS[k]}</span>
            <span className="flex-1 text-slate-400">weight {Math.round(person.weights[k] * 100)}%</span>
            <span className="font-mono text-slate-600">+{(person.weights[k] * person.factors[k] * 100).toFixed(1)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-400">Weights follow the goal you picked in Setup.</p>
    </div>
  );
}

/** The double opt-in intro flow for one candidate: who, why, next step and draft. */
function IntroAction({ c, evalDate }: { c: Candidate; evalDate: string }) {
  const r = first(c.recipient.name);
  const p = first(c.proposed.name);
  const kind = draftKindFor(c);
  const step = {
    ask_recipient: { n: 1, label: `Ask ${r} if they want the intro`, yes: "recipient_yes", yesLabel: `${r} said yes` },
    ask_proposed: { n: 2, label: `Check ${p} is open to it`, yes: "proposed_yes", yesLabel: `${p} said yes` },
    intro: { n: 3, label: `Introduce ${r} and ${p}`, yes: "intro_sent", yesLabel: "Mark intro sent" },
  }[kind];
  const twoWay = c.reciprocal.length > 0;
  const whyNow =
    c.opp.why_now ??
    (c.score.daysSinceInteraction != null ? `You haven't connected in ${c.score.daysSinceInteraction} days.` : null);

  return (
    <div className="space-y-6">
          {/* The two people and what flows between them */}
          <div className="grid items-center gap-4 rounded-2xl bg-gradient-to-r from-violet-50/60 via-white to-sky-50/60 p-4 sm:p-5 md:grid-cols-[1fr_auto_1fr]">
            <Person name={c.recipient.name} role={[c.recipient.title, c.recipient.company]}>
              <NeedChip tone="violet" label="Needs">
                {c.need.description}
                {c.need.is_inferred && <span className="opacity-60"> · inferred</span>}
              </NeedChip>
            </Person>
            <div className="flex justify-center text-ink-500" title={twoWay ? "Helps both people" : undefined}>
              <span className="flex size-10 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-slate-200/70">
                {twoWay ? <ArrowLeftRight className="size-5" /> : <ArrowRight className="size-5" />}
              </span>
            </div>
            <Person name={c.proposed.name} role={[c.proposed.title, c.proposed.company]}>
              <NeedChip tone="sky" label="Can give">
                {c.offer?.description ?? "Relevant experience (from profile)"}
              </NeedChip>
            </Person>
          </div>

          <div className="grid gap-6 md:grid-cols-2 md:divide-x md:divide-slate-100">
            <Reason icon={<Sparkles className="size-5" />} title="Why this is a great match">
              {c.opp.why_proposed}
              {c.opp.match_basis === "profile_inference" && (
                <Chip tone="slate" className="ml-2 align-middle">
                  profile only
                </Chip>
              )}
              {twoWay && (
                <span className="mt-2 block text-ink-700">
                  <span className="font-medium">Two-way:</span> helps {p} too ({c.reciprocal[0].need.description}).
                </span>
              )}
            </Reason>
            {whyNow && (
              <Reason icon={<CalendarClock className="size-5" />} title="Why now" className="md:pl-6">
                {whyNow}
              </Reason>
            )}
          </div>

          {clean(c.opp.concerns) && (
            <div className="flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200/70">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              {clean(c.opp.concerns)}
            </div>
          )}

          {/* Next action */}
          <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">Next step</p>
                <p className="font-semibold text-slate-900">{step.label}</p>
              </div>
              <Stepper current={step.n} labels={[`Ask ${r}`, `Check ${p}`, "Introduce"]} />
            </div>
            <Suspense fallback={<DraftSkeleton />}>
              <Draft c={c} label={kind === "intro" ? `To ${r} & ${p}` : `To ${kind === "ask_recipient" ? r : p}`} />
            </Suspense>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <form action={advanceAction} className="flex gap-2">
                <input type="hidden" name="id" value={c.opp.id} />
                <SubmitButton name="step" value={step.yes} pendingText="Saving…" className={btn.primary}>
                  {kind === "intro" ? <Send className="size-4" /> : <Check className="size-4" />}
                  {step.yesLabel}
                </SubmitButton>
                {kind !== "intro" && (
                  <SubmitButton name="step" value="declined" pendingText="Saving…" className={btn.secondary}>
                    Not interested
                  </SubmitButton>
                )}
              </form>
              <form action={redraftAction}>
                <input type="hidden" name="id" value={c.opp.id} />
                <SubmitButton pendingText="Redrafting…" className={btn.ghost}>
                  <RefreshCw className="size-3.5" /> Redraft
                </SubmitButton>
              </form>
              <form action={setStatusAction} className="flex flex-wrap gap-0.5 sm:ml-auto">
                <input type="hidden" name="id" value={c.opp.id} />
                <input type="hidden" name="eval_date" value={evalDate} />
                <SubmitButton name="status" value="deferred" pendingText="…" className={`!px-2.5 text-xs ${btn.ghost}`}>
                  Not now (7d)
                </SubmitButton>
                <SubmitButton name="status" value="dismissed" pendingText="…" className={`!px-2.5 text-xs ${btn.ghost}`}>
                  Not relevant
                </SubmitButton>
                <SubmitButton name="status" value="completed" pendingText="…" className={`!px-2.5 text-xs ${btn.ghost}`}>
                  Already handled
                </SubmitButton>
              </form>
            </div>
          </div>

          <details className="group/ev">
            <summary className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
              <ChevronDown className="size-4 transition group-open/ev:rotate-180" /> Evidence &amp; score breakdown
            </summary>
            <div className="mt-4 grid gap-6 md:grid-cols-2">
              <div className="space-y-3">
                <Evidence label={`${r}, ${c.need.note_date}`} text={c.need.supporting_text} verified={c.need.quote_verified} />
                {c.offer && (
                  <Evidence label={`${p}, ${c.offer.note_date}`} text={c.offer.supporting_text} verified={c.offer.quote_verified} />
                )}
                {c.opp.missing_evidence && (
                  <p className="text-xs text-slate-500">
                    <span className="font-medium">Unknown:</span> {c.opp.missing_evidence}
                  </p>
                )}
              </div>
              <ScoreBreakdown c={c} />
            </div>
          </details>
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  return (
    <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-ink-50 px-3.5 py-1.5 text-sm font-semibold text-ink-900 sm:inline-flex">
      <TrendingUp className="size-4 text-ink-600" />
      {Math.round(score)}
      <span className="font-medium text-ink-900/50">/ 100</span>
    </span>
  );
}

function Person({ name, role, children }: { name: string; role: (string | null)[]; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <Avatar name={name} size="lg" />
      <div className="min-w-0 space-y-1.5">
        <div>
          <div className="font-bold text-slate-950">{name}</div>
          <div className="truncate text-sm text-slate-500">{role.filter(Boolean).join(", ")}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

function NeedChip({ tone, label, children }: { tone: "violet" | "sky"; label: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block rounded-xl px-3 py-1 text-[13px] leading-snug ring-1 ring-inset ${
        tone === "violet" ? "bg-violet-50 text-violet-900 ring-violet-200/70" : "bg-sky-50 text-sky-900 ring-sky-200/70"
      }`}
    >
      <span className="font-semibold">{label}:</span> {children}
    </span>
  );
}

function Reason({
  icon,
  title,
  children,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex gap-3 ${className}`}>
      <span className="mt-0.5 text-ink-500">{icon}</span>
      <div>
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{children}</p>
      </div>
    </div>
  );
}

function Stepper({ current, labels }: { current: number; labels: string[] }) {
  return (
    <ol className="flex items-center gap-1.5 text-xs font-medium">
      {labels.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const active = n === current;
        return (
          <li key={label} className="flex items-center gap-1.5">
            {i > 0 && <span className={`h-px w-4 ${done || active ? "bg-ink-300" : "bg-slate-200"}`} />}
            <span
              className={`flex items-center gap-1.5 rounded-full px-2 py-1 ${
                active ? "bg-ink-900 text-white" : done ? "bg-ink-50 text-ink-700" : "text-slate-400"
              }`}
            >
              <span
                className={`flex size-4 items-center justify-center rounded-full text-[10px] ${
                  active ? "bg-white/20" : done ? "bg-ink-600 text-white" : "ring-1 ring-slate-300"
                }`}
              >
                {done ? <Check className="size-2.5" strokeWidth={3} /> : n}
              </span>
              <span className={`max-w-24 truncate ${active ? "" : "hidden sm:inline"}`}>{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function DraftSkeleton() {
  return (
    <div className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-600">
        <Sparkles className="size-3.5 animate-pulse" /> Claude is drafting your message…
      </div>
      {[92, 100, 85, 60].map((w) => (
        <div key={w} className="h-2.5 animate-pulse rounded-full bg-slate-100" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

async function Draft({ c, label }: { c: Candidate; label: string }) {
  const result = await getOrCreateDraft(await requireCtx(), c).then(
    (draft) => ({ draft, error: null }),
    (e: Error) => ({ draft: null, error: e.message }),
  );
  if (result.draft == null) {
    return (
      <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t draft a message: {result.error}</p>
    );
  }
  return <DraftBox key={result.draft} draft={result.draft} label={label} />;
}

function Evidence({ label, text, verified }: { label: string; text: string; verified: boolean }) {
  return (
    <figure className="rounded-xl border-l-[3px] border-ink-200 bg-slate-50 px-4 py-3">
      <blockquote className="text-sm leading-relaxed text-slate-700">&ldquo;{text}&rdquo;</blockquote>
      <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {label}
        {verified ? (
          <Chip tone="emerald">
            <BadgeCheck className="size-3" /> verbatim in note
          </Chip>
        ) : (
          <Chip tone="amber">
            <TriangleAlert className="size-3" /> paraphrase
          </Chip>
        )}
      </figcaption>
    </figure>
  );
}

const FACTOR_COLORS = ["bg-ink-600", "bg-violet-400", "bg-sky-400", "bg-indigo-300", "bg-slate-300"];

function ScoreBreakdown({ c }: { c: Candidate }) {
  const rows = [
    ["Give value", c.score.give, WEIGHTS.give, `${c.opp.give_value}/5`],
    ["Connection cooling", c.score.cooling, WEIGHTS.cooling, c.score.daysSinceInteraction != null ? `${c.score.daysSinceInteraction}d since contact` : "unknown"],
    ["Timeliness", c.score.timeliness, WEIGHTS.timeliness, `need noted ${c.score.daysSinceNote}d ago`],
    ["Relationship strength", c.score.relationship, WEIGHTS.relationship, "avg of both"],
    ["Match confidence", c.score.confidence, WEIGHTS.confidence, c.opp.match_basis.replace("_", " ")],
  ] as const;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-800">Priority score</span>
        <span className="text-sm font-semibold text-slate-900">
          {c.score.total} <span className="font-normal text-slate-400">/ 100</span>
        </span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {rows.map(([label, value, weight], i) => (
          <div key={label} className={`${FACTOR_COLORS[i]} border-r border-white last:border-0`} style={{ width: `${value * weight * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs">
        {rows.map(([label, value, weight, note], i) => (
          <li key={label} className="flex items-center gap-2">
            <span className={`size-2 shrink-0 rounded-full ${FACTOR_COLORS[i]}`} />
            <span className="w-36 text-slate-700">{label}</span>
            <span className="flex-1 truncate text-slate-400">{note}</span>
            <span className="font-mono text-slate-600">+{(value * weight * 100).toFixed(1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Welcome() {
  return (
    <div className="mx-auto mt-10 max-w-xl">
      <div className={`${card} flex flex-col items-center px-8 py-14 text-center`}>
        <Logo size={44} />
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-slate-950">Your network is empty</h1>
        <p className="mt-3 leading-relaxed text-slate-500">
          Add people with <span className="font-medium text-slate-700">Add contact</span> or import a CSV on the Contacts
          page, then log what you learn in conversations. Or explore Daily Networker with a ready-made demo network: 30
          fictional contacts with notes, plus 5 public figures enriched from the web.
        </p>
        <form action={loadDemoAction} className="mt-8">
          <SubmitButton pendingText="Loading…" className={`${btn.primary} !px-5 !py-2.5`}>
            <Sparkles className="size-4" /> Load demo contacts
          </SubmitButton>
        </form>
        <p className="mt-4 text-xs text-slate-400">You can remove the demo contacts later from the Contacts page.</p>
      </div>
    </div>
  );
}
