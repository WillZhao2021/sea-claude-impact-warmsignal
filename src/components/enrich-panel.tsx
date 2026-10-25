"use client";

import Link from "next/link";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Globe,
  LoaderCircle,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { EnrichEvent, SearchGroup } from "@/lib/enrich";
import type { NetworkEvent } from "@/lib/network";
import type { NetworkMap } from "@/lib/types";
import { AttributeChips, GoalFitCard, IdeaList, IntroList, OverlapChips, Section, SignalList } from "./enrichment-view";
import { btn, Chip } from "./ui";

type Frame = EnrichEvent | NetworkEvent | { type: "saved"; intros_saved: number; intros_added: number } | { type: "error"; message: string };
type Source = { title: string; url: string; date: string | null };
type ProfilePartial = {
  identity_confidence?: string;
  identity_notes?: string;
  summary?: string;
  attributes?: { kind?: string; label?: string }[];
  recent_signals?: { kind?: string; text?: string; date?: string | null }[];
  possible_offers?: { text?: string }[];
};
const PHASES = ["searching", "reading", "verifying", "mapping", "done"] as const;
type Run = {
  phase: (typeof PHASES)[number] | "error";
  queries: SearchGroup[];
  sources: Record<string, Source[]>;
  readCount: number;
  profile: ProfilePartial;
  outcome: "matched" | "no_confident_match" | null;
  scope: { contacts: number; needs: number } | null;
  overlaps: NetworkMap["overlaps"];
  network: Pick<NetworkMap, "intros" | "ideas" | "goal_fit">;
  introsSaved: number | null;
  introsAdded: number;
  error: string | null;
  started: number;
};

const fresh = (): Run => ({
  phase: "searching",
  queries: [],
  sources: {},
  readCount: 0,
  profile: {},
  outcome: null,
  scope: null,
  overlaps: [],
  network: { intros: [], ideas: [] },
  introsSaved: null,
  introsAdded: 0,
  error: null,
  started: Date.now(),
});

/**
 * Web profile panel. Idle: shows the saved profile (children, server-rendered).
 * Running: streams enrichment and network mapping live from /api/contacts/[id]/enrich (SSE over fetch).
 */
export function EnrichPanel({
  contactId,
  name,
  enriched,
  children,
}: {
  contactId: string;
  name: string;
  enriched: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function start() {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setRun(fresh());
    const update = (fn: (r: Run) => Run) => setRun((r) => (r ? fn(r) : r));
    const fail = (message: string) => update((r) => ({ ...r, phase: "error", error: message }));

    try {
      const res = await fetch(`/api/contacts/${contactId}/enrich`, { method: "POST", signal: abort.signal });
      if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
        const body = await res.json().catch(() => null);
        return fail(body?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) handle(JSON.parse(data) as Frame);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) fail(e instanceof Error ? e.message : "Connection lost");
    }

    function handle(f: Frame) {
      switch (f.type) {
        case "searching":
          return update((r) => ({ ...r, queries: f.queries }));
        case "sources":
          return update((r) => ({ ...r, sources: { ...r.sources, [f.group]: f.sources } }));
        case "reading":
          return update((r) => ({ ...r, phase: "reading", readCount: f.count }));
        case "partial":
          return update((r) => ({ ...r, profile: (f.data ?? {}) as ProfilePartial }));
        case "verifying":
          return update((r) => ({ ...r, phase: "verifying" }));
        case "result":
          return update((r) => ({ ...r, outcome: f.enrichment.status }));
        case "mapping":
          return update((r) => ({ ...r, phase: "mapping", scope: { contacts: f.contacts, needs: f.needs } }));
        case "overlaps":
          return update((r) => ({ ...r, overlaps: f.overlaps }));
        case "network_partial":
          return update((r) => ({ ...r, network: f.data }));
        case "network":
          return update((r) => ({ ...r, network: f.network, overlaps: f.network.overlaps }));
        case "saved":
          update((r) => ({ ...r, phase: "done", introsSaved: f.intros_saved, introsAdded: f.intros_added }));
          // Refresh server data so the saved profile and briefing reflect this run.
          router.refresh();
          return;
        case "error":
          return fail(f.message);
      }
    }
  }

  const running = run != null && run.phase !== "done" && run.phase !== "error";

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 text-sm shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-bold tracking-tight">
            <Globe className="size-4 text-ink-500" /> Profile &amp; network
          </h2>
          <p className="text-xs text-slate-400">Public web via Tavily + Claude · unverified</p>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={running}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60 ${btn.secondary}`}
        >
          <RefreshCw className={`size-3.5 ${running ? "animate-spin" : ""}`} />
          {running ? "Enriching…" : enriched ? "Refresh" : "Enrich now"}
        </button>
      </div>
      {run ? (
        <LiveRun key={run.started} run={run} name={name} onRetry={start} onClose={() => setRun(null)} />
      ) : (
        children
      )}
    </section>
  );
}

function LiveRun({ run, name, onRetry, onClose }: { run: Run; name: string; onRetry: () => void; onClose: () => void }) {
  const first = name.split(" ")[0];
  const elapsed = useElapsed(run.started, run.phase === "done" || run.phase === "error");
  const at = run.phase === "error" ? -1 : PHASES.indexOf(run.phase);
  const state = (i: number) => (run.phase === "done" || at > i ? "done" : at === i ? "active" : "waiting");
  const searchesDone = Object.keys(run.sources).length;
  const totalSources = Object.values(run.sources).reduce((n, s) => n + s.length, 0);
  const p = run.profile;
  const weak = p.identity_confidence === "low" || p.identity_confidence === "none";

  return (
    <div className="mt-4" aria-live="polite">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="font-medium text-ink-700">
          {run.phase === "done" ? "Finished" : run.phase === "error" ? "Stopped" : "Live"}
        </span>
        <span className="font-mono text-slate-400">{elapsed}s</span>
      </div>

      <Step
        state={state(0)}
        icon={Search}
        title={
          run.queries.length && searchesDone === run.queries.length
            ? `Ran ${run.queries.length} searches · ${totalSources} results`
            : `Searching the web${run.queries.length ? ` (${searchesDone}/${run.queries.length})` : ""}`
        }
      >
        <div className="space-y-2.5">
          {run.queries.map((q) => {
            const found = run.sources[q.id];
            return (
              <div key={q.id}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {found ? <Check className="size-3 text-ink-500" /> : <LoaderCircle className="size-3 animate-spin" />}
                  {q.label}
                  {found && <span className="font-normal normal-case tracking-normal">· {found.length}</span>}
                </div>
                {found && found.length > 0 && at > 0 && (
                  <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                    {[...new Set(found.map((s) => hostname(s.url)))].join(" · ")}
                  </div>
                )}
                {found && found.length > 0 && at <= 0 && (
                  <ul className="mt-1 space-y-1">
                    {found.slice(0, 4).map((s, i) => (
                      <li key={s.url} className="flex animate-rise items-center gap-2 text-xs" style={{ animationDelay: `${i * 50}ms` }}>
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                          {hostname(s.url)}
                        </span>
                        <span className="truncate text-slate-600">{s.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Step>

      <Step
        state={state(1)}
        icon={Sparkles}
        title={
          run.outcome === "no_confident_match"
            ? "No confident web match"
            : run.readCount
              ? `Claude is building the profile from ${run.readCount} sources`
              : "Build the profile"
        }
      >
        <div className="space-y-2">
          {p.identity_confidence && (
            <Chip tone={weak ? "amber" : "emerald"} className="animate-rise">
              {weak ? <CircleAlert className="size-3" /> : <ShieldCheck className="size-3" />}
              {p.identity_confidence} identity confidence
            </Chip>
          )}
          {p.identity_notes && <p className="text-xs leading-relaxed text-slate-500">{p.identity_notes}</p>}
          {p.summary && (
            <p className="leading-relaxed text-slate-700">
              {p.summary}
              {run.phase === "reading" && !p.attributes?.length && <Caret />}
            </p>
          )}
          {!!p.attributes?.length && <AttributeChips attributes={p.attributes as never} />}
          {!!p.recent_signals?.length && <SignalList signals={p.recent_signals} />}
          {!!p.possible_offers?.filter((o) => o.text).length && (
            <p className="animate-rise text-xs text-slate-600">
              <span className="font-medium">Could offer:</span>{" "}
              {p.possible_offers.filter((o) => o.text).map((o) => o.text).join("; ")}
            </p>
          )}
        </div>
      </Step>

      <Step state={state(2)} icon={ShieldCheck} title="Checking every claim has a source" />

      <Step
        state={state(3)}
        icon={Network}
        title={
          run.scope
            ? `Mapping against ${run.scope.contacts} people and ${run.scope.needs} recorded needs`
            : "Map against your network"
        }
      >
        <div className="space-y-3">
          {run.network.goal_fit && <GoalFitCard fit={run.network.goal_fit} />}
          {run.overlaps.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Common ground</div>
              <OverlapChips overlaps={run.overlaps} />
            </div>
          )}
          {run.network.intros.length > 0 && <IntroList intros={run.network.intros} firstName={first} />}
          {run.phase === "mapping" && !run.network.intros.length && (
            <p className="flex items-center gap-1.5 text-xs text-slate-400">
              <LoaderCircle className="size-3 animate-spin" /> Claude is checking who {first} can help, and who can help{" "}
              {first}…
            </p>
          )}
          {run.network.ideas.length > 0 && (
            <Section title="Ideas to verify">
              <IdeaList ideas={run.network.ideas} />
            </Section>
          )}
        </div>
      </Step>

      <Step
        state={state(4)}
        icon={Check}
        title={
          run.phase !== "done"
            ? "Save"
            : run.introsSaved
              ? `Saved · ${run.introsSaved} introduction${run.introsSaved > 1 ? "s" : ""} in your briefing pipeline${run.introsAdded ? ` (${run.introsAdded} new)` : ""}`
              : "Saved to profile"
        }
        last
      >
        {run.phase === "done" && (
          <div className="flex flex-wrap gap-2">
            {!!run.introsSaved && (
              <Link href="/" className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${btn.primary}`}>
                Open briefing <ArrowRight className="size-3.5" />
              </Link>
            )}
            <button type="button" onClick={onClose} className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${btn.ghost}`}>
              Show saved profile
            </button>
          </div>
        )}
      </Step>

      {run.phase === "error" && (
        <div className="mt-3 rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-700">
          <div className="flex items-start gap-1.5">
            <CircleAlert className="mt-px size-3.5 shrink-0" /> {run.error}
          </div>
          <button type="button" onClick={onRetry} className="mt-2 font-semibold underline-offset-2 hover:underline">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function Step({
  state,
  icon: Icon,
  title,
  children,
  last = false,
}: {
  state: "waiting" | "active" | "done";
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="relative flex gap-3">
      {!last && <span className={`absolute bottom-0 left-[11px] top-7 w-px ${state === "done" ? "bg-ink-200" : "bg-slate-100"}`} />}
      <span
        className={`relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition ${
          state === "done"
            ? "bg-ink-600 text-white"
            : state === "active"
              ? "bg-ink-50 text-ink-600 ring-4 ring-ink-50"
              : "bg-slate-100 text-slate-300"
        }`}
      >
        {state === "done" ? (
          <Check className="size-3.5" />
        ) : state === "active" ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Icon className="size-3" />
        )}
      </span>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
        <div className={`pt-0.5 font-medium ${state === "waiting" ? "text-slate-400" : "text-slate-800"}`}>{title}</div>
        {children && state !== "waiting" && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-ink-500" />;
}

function useElapsed(started: number, stopped: boolean) {
  const [now, setNow] = useState(started);
  useEffect(() => {
    if (stopped) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [stopped]);
  return ((now - started) / 1000).toFixed(1);
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
