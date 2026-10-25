"use client";

import { Check, Gift, Handshake, LoaderCircle, Quote, Sprout } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { saveAnswersAction } from "@/app/onboarding/actions";
import { Chips, Group, Segmented, Slider } from "@/components/onboarding/flow";
import { btn, card, input } from "@/components/ui";
import { GOALS, INDUSTRIES, OFFERS, profilePrompt, REVENUE, ROLES, type Profile, type Tone } from "@/lib/profile";

// The "Me" editor: every onboarding answer on one page, saved together. Reuses onboarding's
// controls and its validated save action, so both places stay in step.

const GOAL_ICONS = { give: Gift, ask: Handshake } as const;
/** No goal set = the default: cultivate the network (stay in touch, help where you can, no asks). */
const DEFAULT_GOAL = { id: null, name: "Cultivate my network", sub: "Default. Stay in touch and help where you can" } as const;
const FIELDS = [
  "full_name",
  "offers",
  "offer_line",
  "goal",
  "industries",
  "roles",
  "revenue",
  "per_day",
  "asks_per_week",
  "gives_per_ask",
  "rest_days",
  "tone",
] as const satisfies readonly (keyof Profile)[];

export function ProfileForm({ initial }: { initial: Profile }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [p, setP] = useState(initial);
  const [pending, start] = useTransition();
  const [justSaved, setJustSaved] = useState(false);
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setP((prev) => ({ ...prev, [key]: value }));
  const changed = FIELDS.filter((k) => JSON.stringify(p[k]) !== JSON.stringify(saved[k]));

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(t);
  }, [justSaved]);

  function save() {
    const patch = Object.fromEntries(changed.map((k) => [k, p[k]])) as Partial<Profile>;
    start(async () => {
      await saveAnswersAction(patch);
      setSaved(p);
      setJustSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6 pb-24">
      <FormCard title="How Daily Networker describes you" lead="This is the context Claude gets when it ranks introductions and drafts your messages.">
        <p className="flex gap-3 rounded-xl bg-ink-50/60 px-4 py-3 text-sm leading-relaxed text-ink-900">
          <Quote className="mt-0.5 size-4 shrink-0 text-ink-400" />
          {profilePrompt(p)}
        </p>
      </FormCard>

      <FormCard title="Your name" lead="Drafted messages are signed with your first name.">
        <input
          value={p.full_name ?? ""}
          onChange={(e) => set("full_name", e.target.value)}
          placeholder="e.g. Alex Rivera"
          autoComplete="name"
          maxLength={80}
          className={input}
        />
      </FormCard>

      <FormCard title="What you offer" lead="Used to recognize who needs you and to write messages that sound like you.">
        <Chips options={OFFERS.map(([id, label]) => [id, label])} selected={p.offers} onChange={(v) => set("offers", v)} />
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-slate-700">In one line</span>
          <input
            value={p.offer_line ?? ""}
            onChange={(e) => set("offer_line", e.target.value)}
            placeholder="e.g. Fractional CMO for B2B service firms"
            maxLength={200}
            className={input}
          />
        </label>
      </FormCard>

      <FormCard title="Your goal right now" lead="Breaks ties between introductions and frames your drafts. Daily Networker always leads with giving.">
        <div className="grid gap-2.5 sm:grid-cols-3">
          {[DEFAULT_GOAL, ...GOALS].map((g) => {
            const Icon = g.id ? GOAL_ICONS[g.id] : Sprout;
            const on = p.goal === g.id;
            return (
              <button
                key={g.id ?? "cultivate"}
                type="button"
                aria-pressed={on}
                onClick={() => set("goal", g.id)}
                className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                  on ? "border-ink-500 bg-ink-50 ring-4 ring-ink-100" : "border-slate-200 bg-white shadow-sm hover:border-slate-300"
                }`}
              >
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${on ? "bg-ink-900 text-white" : "bg-slate-100 text-ink-700"}`}>
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">{g.name}</span>
                  <span className="block text-xs text-slate-500">{g.sub}</span>
                </span>
              </button>
            );
          })}
        </div>
      </FormCard>

      <FormCard title="Ideal clients" lead="Optional. Leave anything that doesn't apply.">
        <Group label="Industry">
          <Chips options={INDUSTRIES.map((x) => [x, x])} selected={p.industries} onChange={(v) => set("industries", v)} />
        </Group>
        <Group label="Their role">
          <Chips options={ROLES.map(([id, l]) => [id, l])} selected={p.roles} onChange={(v) => set("roles", v)} />
        </Group>
        <Group label="Company size (annual revenue)">
          <Chips options={REVENUE.map(([id, l]) => [id, l])} selected={p.revenue} exclusive="any" onChange={(v) => set("revenue", v)} />
        </Group>
      </FormCard>

      <FormCard title="Reach-out rhythm" lead="How often Daily Networker nudges you, and how your drafts sound.">
        <div className="grid gap-6 md:grid-cols-2">
          <Slider label="Introductions per day" value={p.per_day} min={1} max={10} format={(v) => `${v} ${v === 1 ? "person" : "people"}`} onChange={(v) => set("per_day", v)} />
          <Slider label="Asks per week, at most" value={p.asks_per_week} min={0} max={5} format={(v) => (v === 0 ? "no asks" : `${v} per week`)} onChange={(v) => set("asks_per_week", v)} />
          <Slider label="Give before you ask" value={p.gives_per_ask} min={0} max={5} format={(v) => (v === 0 ? "off" : `${v} gives per ask`)} onChange={(v) => set("gives_per_ask", v)} />
          <Slider label="Rest after reaching out" value={p.rest_days} min={3} max={60} format={(v) => `${v} days`} onChange={(v) => set("rest_days", v)} />
        </div>
        <Group label="Message tone">
          <Segmented
            options={[
              ["warm", "Warm"],
              ["professional", "Professional"],
              ["brief", "Brief"],
            ]}
            value={p.tone}
            onChange={(v) => set("tone", v as Tone)}
          />
        </Group>
      </FormCard>

      {/* Save bar: appears once something changes */}
      <div
        className={`fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-5 transition duration-300 lg:pl-64 ${
          changed.length || justSaved ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-6 opacity-0"
        }`}
      >
        <div className={`${card} flex items-center gap-3 px-4 py-3 shadow-card-lg`}>
          {justSaved && !changed.length ? (
            <span className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <Check className="size-4" /> Saved. Matching and drafts use your new answers.
            </span>
          ) : (
            <>
              <span className="text-sm text-slate-600">
                {changed.length} unsaved {changed.length === 1 ? "change" : "changes"}
              </span>
              <button type="button" onClick={() => setP(saved)} disabled={pending} className={`rounded-lg px-3 py-2 text-sm font-medium ${btn.ghost}`}>
                Discard
              </button>
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-70 ${btn.primary}`}
              >
                {pending && <LoaderCircle className="size-4 animate-spin" />}
                {pending ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FormCard({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section className={`${card} space-y-5 p-6`}>
      <div>
        <h2 className="text-lg font-bold tracking-tight text-slate-950">{title}</h2>
        {lead && <p className="mt-1 text-sm text-slate-500">{lead}</p>}
      </div>
      {children}
    </section>
  );
}
