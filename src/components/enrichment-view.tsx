import Link from "next/link";
import { ArrowLeft, ArrowRight, BadgeCheck, ExternalLink, HandHeart, Lightbulb, Network, Target, TriangleAlert } from "lucide-react";
import type { Attribute, Enrichment, GoalFit, NetworkMap } from "@/lib/types";
import { Avatar, Chip } from "./ui";

// Presentational pieces for a contact's enrichment. Used for the saved profile (server) and,
// piece by piece, by the live panel while results stream in. No hooks, no server-only imports.

const ATTRIBUTE_TONE: Record<Attribute["kind"], string> = {
  expertise: "bg-violet-50 text-violet-800 ring-violet-200/70",
  sector: "bg-sky-50 text-sky-800 ring-sky-200/70",
  stage: "bg-indigo-50 text-indigo-800 ring-indigo-200/70",
  location: "bg-emerald-50 text-emerald-800 ring-emerald-200/70",
  role: "bg-slate-100 text-slate-700 ring-slate-200",
  affiliation: "bg-amber-50 text-amber-800 ring-amber-200/70",
  interest: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200/70",
};

export function AttributeChips({ attributes, max }: { attributes: Partial<Attribute>[]; max?: number }) {
  const shown = attributes.filter((a) => a.label).slice(0, max);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((a, i) => (
        <span
          key={`${a.label}-${i}`}
          title={a.kind}
          className={`inline-flex animate-rise items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
            ATTRIBUTE_TONE[a.kind as Attribute["kind"]] ?? ATTRIBUTE_TONE.role
          }`}
        >
          {a.label}
        </span>
      ))}
    </div>
  );
}

export function SignalList({ signals }: { signals: { kind?: string; text?: string; date?: string | null; source_url?: string }[] }) {
  return (
    <ul className="space-y-2">
      {signals
        .filter((s) => s.text)
        .map((s, i) => (
          <li key={i} className="flex animate-rise items-start gap-2 text-xs text-slate-700">
            {s.kind && <Chip tone="sky">{s.kind.replace("_", " ")}</Chip>}
            <span className="flex-1 pt-0.5">
              {s.text}
              {s.date && <span className="ml-1 text-slate-400">{s.date}</span>}
            </span>
            {s.source_url && (
              <a href={s.source_url} target="_blank" rel="noreferrer" className="pt-0.5 text-slate-300 hover:text-ink-600" title="Source">
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </li>
        ))}
    </ul>
  );
}

const GOAL_FIT = {
  strong: { label: "Strong fit with your goal", chip: "Strong goal fit", tone: "bg-emerald-50 text-emerald-800 ring-emerald-200/70" },
  some: { label: "Some fit with your goal", chip: "Some goal fit", tone: "bg-sky-50 text-sky-800 ring-sky-200/70" },
  none: { label: "Not related to your goal", chip: "No goal fit", tone: "bg-slate-100 text-slate-600 ring-slate-200" },
} as const;

/** Small chip for headers and lists. Hidden for "none" unless asked, to keep lists quiet. */
export function GoalFitChip({ fit, showNone = false }: { fit: GoalFit | undefined; showNone?: boolean }) {
  if (!fit || (fit.level === "none" && !showNone)) return null;
  const f = GOAL_FIT[fit.level];
  return (
    <span title={fit.why} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${f.tone}`}>
      <Target className="size-3" /> {f.chip}
    </span>
  );
}

export function GoalFitCard({ fit }: { fit: Partial<GoalFit> }) {
  if (!fit.level) return null;
  const f = GOAL_FIT[fit.level];
  return (
    <div className={`animate-rise rounded-xl px-3 py-2.5 ring-1 ring-inset ${f.tone}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Target className="size-3.5" /> {f.label}
      </div>
      {fit.why && <p className="mt-0.5 text-xs leading-relaxed opacity-90">{fit.why}</p>}
    </div>
  );
}

export function GiveMeter({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" title={`Give value ${value}/5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={`h-1.5 w-2.5 rounded-full ${i < value ? "bg-ink-500" : "bg-slate-200"}`} />
      ))}
    </span>
  );
}

export function IntroList({ intros, firstName }: { intros: NetworkMap["intros"]; firstName: string }) {
  if (!intros.length) return null;
  return (
    <ul className="space-y-2">
      {intros.map((x, i) => (
        <li key={`${x.direction}-${x.other_contact_id}-${i}`} className="animate-rise">
          <Link
            href={`/contacts/${x.other_contact_id}`}
            className="group flex gap-2.5 rounded-xl p-2 ring-1 ring-inset ring-slate-100 transition hover:bg-ink-50/40 hover:ring-ink-100"
          >
            <Avatar name={x.other_name} size="sm" />
            <div className="min-w-0 flex-1 text-xs">
              <div className="flex items-center gap-1.5">
                <span className={`inline-flex items-center gap-1 font-semibold ${x.direction === "gives" ? "text-ink-700" : "text-sky-700"}`}>
                  {x.direction === "gives" ? <ArrowRight className="size-3" /> : <ArrowLeft className="size-3" />}
                  {x.direction === "gives" ? `${firstName} can help ${x.other_name}` : `${x.other_name} can help ${firstName}`}
                </span>
              </div>
              {x.need && <div className="mt-0.5 text-slate-600">Need: {x.need}</div>}
              <div className="mt-0.5 leading-relaxed text-slate-500">{x.why}</div>
              <div className="mt-1.5 flex items-center gap-2">
                <GiveMeter value={x.give_value} />
                {!x.appropriate && (
                  <Chip tone="amber">
                    <TriangleAlert className="size-3" /> handle with care
                  </Chip>
                )}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function IdeaList({ ideas }: { ideas: NetworkMap["ideas"] }) {
  if (!ideas.length) return null;
  return (
    <ul className="space-y-1.5">
      {ideas.map((x, i) => (
        <li key={i} className="flex animate-rise items-start gap-2 text-xs text-slate-600">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            {x.text}{" "}
            {x.other_contact_id && x.other_name && (
              <Link href={`/contacts/${x.other_contact_id}`} className="font-medium text-ink-700 hover:underline">
                {x.other_name}
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OverlapChips({ overlaps }: { overlaps: NetworkMap["overlaps"] }) {
  if (!overlaps.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {overlaps.map((o) => (
        <span
          key={o.label}
          title={o.names.join(", ")}
          className="inline-flex animate-rise items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200/70"
        >
          <span className="font-medium text-slate-800">{o.label}</span>
          <span className="rounded bg-white px-1 font-mono text-[10px] text-slate-500">{o.names.length}</span>
        </span>
      ))}
    </div>
  );
}

export function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-100 pt-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}

export function NetworkView({ network, firstName }: { network: NetworkMap; firstName: string }) {
  const empty = !network.intros.length && !network.ideas.length && !network.overlaps.length;
  return (
    <>
      {network.goal_fit && (
        <Section title="Your goal" icon={<Target className="size-3.5" />}>
          <GoalFitCard fit={network.goal_fit} />
        </Section>
      )}
      {network.intros.length > 0 && (
        <Section title={`Introductions (${network.intros.length})`} icon={<Network className="size-3.5" />}>
          <IntroList intros={network.intros} firstName={firstName} />
        </Section>
      )}
      {network.ideas.length > 0 && (
        <Section title="Ideas to verify" icon={<Lightbulb className="size-3.5" />}>
          <IdeaList ideas={network.ideas} />
        </Section>
      )}
      {network.overlaps.length > 0 && (
        <Section title="Common ground">
          <OverlapChips overlaps={network.overlaps} />
        </Section>
      )}
      {empty && (
        <Section title="In your network">
          <p className="text-xs text-slate-400">No connections to the rest of your network yet.</p>
        </Section>
      )}
    </>
  );
}

/** The saved enrichment, as shown when the panel is idle. */
export function EnrichmentView({ enrichment: e, name }: { enrichment: Enrichment | null; name: string }) {
  const first = name.split(" ")[0];
  if (!e) {
    return (
      <p className="mt-4 text-slate-500">
        Not enriched yet. Click <span className="font-medium">Enrich now</span> to search the web and map {first} against
        your network, live.
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-4">
      {e.status === "no_confident_match" ? (
        <p className="text-slate-500">No confident match found online. {e.identity_notes}</p>
      ) : (
        <>
          <p className="leading-relaxed text-slate-700">{e.summary}</p>
          <p className="flex items-start gap-1.5 text-xs text-slate-500">
            <BadgeCheck className="mt-px size-3.5 shrink-0 text-emerald-500" />
            {e.identity_confidence} confidence: {e.identity_notes}
          </p>
          {!!e.attributes?.length && <AttributeChips attributes={e.attributes} />}
          {e.recent_signals.length > 0 && (
            <Section title="Recent news">
              <SignalList signals={e.recent_signals} />
            </Section>
          )}
          {e.possible_offers.length > 0 && (
            <Section title="Could offer" icon={<HandHeart className="size-3.5" />}>
              <ul className="space-y-1 text-xs text-slate-700">
                {e.possible_offers.map((o) => (
                  <li key={o.text}>{o.text}</li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {e.network && <NetworkView network={e.network} firstName={first} />}
    </div>
  );
}
