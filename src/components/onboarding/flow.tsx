"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  FileSpreadsheet,
  Globe,
  LoaderCircle,
  Sparkles,
  Upload,
} from "lucide-react";
import { useState, useTransition } from "react";
import {
  completeOnboardingAction,
  draftMessagesStepAction,
  enrichContactsAction,
  extractNotesAction,
  findIntroductionsStepAction,
  importContactsAction,
  saveAnswersAction,
  summaryAction,
  loadDemoNetworkAction,
  type OnboardingSummary,
} from "@/app/onboarding/actions";
import { Avatar, btn, card, Logo } from "@/components/ui";
import { LINKEDIN_EXPORT_URL } from "@/lib/linkedin";
import { INDUSTRIES, OFFERS, REVENUE, ROLES, type Profile, type Tone } from "@/lib/profile";
import {
  FIELDS,
  guessColumns,
  parseCsv,
  statusLabels,
  toContacts,
  WARMTH,
  type ColumnMap,
  type ParsedCsv,
  type Warmth,
} from "./csv";

// Onboarding: welcome → what you offer → goal → ideal clients → rhythm → contacts → enrichment.
// Answers are saved as you go; the last step runs the real pipeline (Claude extraction,
// web enrichment, matching, drafts) and shows progress between server calls.

type Step = "welcome" | "business" | "clients" | "cadence" | "upload" | "enrich";
// No goal step: everyone starts with the default, cultivating their network (goal = null); Me can change it.
const ORDER: Step[] = ["welcome", "business", "clients", "cadence", "upload", "enrich"];
const STEPS = ORDER.length - 2; // numbered steps, excluding welcome and enrich

/** Simple paces instead of a wall of sliders. Asks per week etc. keep their defaults (editable on Me). */
const PACES = [
  { id: "light", name: "Light", per_day: 2, rest_days: 30, sub: "A few minutes a day", recommended: false },
  { id: "steady", name: "Steady", per_day: 3, rest_days: 21, sub: "A good daily habit", recommended: true },
  { id: "active", name: "Active", per_day: 5, rest_days: 14, sub: "Building momentum fast", recommended: false },
] as const;

type Props = {
  initial: Profile;
  existingContacts: number;
  hasDemo: boolean;
  webEnrichment: boolean;
};

export function OnboardingFlow({ initial, existingContacts, hasDemo, webEnrichment }: Props) {
  const [step, setStep] = useState<Step>(initial.onboarded_at ? "business" : "welcome");
  const [back, setBack] = useState(false);
  // First-time setup starts on the recommended "Steady" pace; re-runs keep the saved one.
  const [p, setP] = useState<Profile>(initial.onboarded_at ? initial : { ...initial, per_day: 3, rest_days: 21 });
  const [saving, startSaving] = useTransition();

  // Contacts step
  const [source, setSource] = useState<"csv" | "demo" | "existing" | null>(null);
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [labels, setLabels] = useState<Record<string, Warmth>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lookupWeb, setLookupWeb] = useState(webEnrichment);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setP((prev) => ({ ...prev, [key]: value }));
  const index = ORDER.indexOf(step);

  function go(next: Step, isBack = false) {
    setBack(isBack);
    setStep(next);
    document.getElementById("onboarding")?.scrollTo({ top: 0 });
  }
  function saveAndGo(next: Step, fields: (keyof Profile)[]) {
    startSaving(async () => {
      await saveAnswersAction(Object.fromEntries(fields.map((f) => [f, p[f]])) as Partial<Profile>);
      go(next);
    });
  }

  const contacts = csv && map ? toContacts(csv, map, labels) : [];
  const withNotes = contacts.filter((c) => (c.notes ?? "").trim().length >= 15).length;

  // ---------- Enrichment run ----------
  const [stage, setStage] = useState(0); // index into STAGES that is running; STAGES.length = done
  const [stageMsg, setStageMsg] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  const [summary, setSummary] = useState<OnboardingSummary | null>(null);
  const [running, setRunning] = useState(false);

  const STAGES = [
    "Reading your notes",
    lookupWeb && source === "csv" ? "Looking people up on the public web" : "Adding public web context",
    "Finding intros you can make",
    "Drafting today's messages",
  ];

  async function run() {
    if (running) return;
    setRunning(true);
    setRunError(null);
    setSummary(null);
    go("enrich");
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      if (source === "csv") {
        setStage(0);
        setStageMsg(`Saving ${contacts.length} contacts…`);
        const { contactIds, noteJobs } = await importContactsAction(contacts);
        for (let i = 0; i < noteJobs.length; i += 6) {
          setStageMsg(`Claude is reading notes ${i + 1}–${Math.min(i + 6, noteJobs.length)} of ${noteJobs.length}…`);
          await extractNotesAction(noteJobs.slice(i, i + 6));
        }
        setStage(1);
        if (lookupWeb && webEnrichment) {
          for (let i = 0; i < contactIds.length; i += 6) {
            setStageMsg(`Searching the web for ${Math.min(i + 6, contactIds.length)} of ${contactIds.length} people…`);
            await enrichContactsAction(contactIds.slice(i, i + 6));
          }
        } else {
          setStageMsg("Skipped: web lookup is off.");
          await pause(400);
        }
        setStage(2);
        setStageMsg("Comparing every need with what your network can offer…");
        await findIntroductionsStepAction();
        setStage(3);
        setStageMsg("Writing the first message for each introduction…");
        await draftMessagesStepAction();
      } else {
        if (source === "demo") {
          setStageMsg("Loading the demo network…");
          await loadDemoNetworkAction();
        }
        // Demo and existing networks are already extracted, enriched and matched; show those steps briefly.
        for (let i = 0; i < STAGES.length - 1; i++) {
          setStage(i);
          setStageMsg(source === "demo" ? "The demo network comes pre-enriched, so this is instant." : "Using your existing network.");
          await pause(450);
        }
        // Drafts are written in the user's own voice and tone, so this step is real work.
        setStage(STAGES.length - 1);
        setStageMsg("Writing the first message for each introduction…");
        await draftMessagesStepAction();
      }
      setStage(STAGES.length);
      setStageMsg("");
      setSummary(await summaryAction());
    } catch (e) {
      setRunError((e as Error).message || "Something went wrong");
      setRunning(false);
    }
  }

  // ---------- Chrome ----------
  const cta: { label: React.ReactNode; onClick: () => void; disabled?: boolean } | null = (() => {
    switch (step) {
      case "welcome":
        return { label: "Get started", onClick: () => go("business") };
      case "business":
        return {
          label: "Continue",
          onClick: () => saveAndGo("clients", ["full_name", "offers", "offer_line"]),
          disabled: !(p.full_name ?? "").trim() || (!p.offers.length && !(p.offer_line ?? "").trim()),
        };
      case "clients":
        return { label: "Continue", onClick: () => saveAndGo("cadence", ["industries", "roles", "revenue"]) };
      case "cadence":
        return {
          label: "Continue",
          onClick: () => saveAndGo("upload", ["per_day", "rest_days", "tone"]),
        };
      case "upload":
        return {
          label: source === "csv" ? "Enrich my contacts" : source ? "Continue" : "Choose your contacts",
          onClick: run,
          disabled: !source || (source === "csv" && !contacts.length),
        };
      case "enrich":
        return summary
          ? { label: "See today's introductions", onClick: () => startSaving(() => completeOnboardingAction()) }
          : runError
            ? { label: "Try again", onClick: run }
            : null;
    }
  })();

  return (
    // Full-screen layer above the app shell: onboarding has no sidebar.
    <div id="onboarding" className="fixed inset-0 z-40 overflow-y-auto bg-[#f8f9fc]">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[900px] -translate-x-1/2 rounded-full bg-gradient-to-b from-indigo-200/50 via-violet-100/40 to-transparent blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-xl flex-col px-5 pb-32 pt-6 sm:pt-10">
        {/* Top bar: back, progress, step count */}
        <div className="flex h-10 items-center gap-3">
          {index > 0 && !(step === "enrich" && !runError) ? (
            <button
              type="button"
              onClick={() => go(ORDER[index - 1], true)}
              aria-label="Back"
              className="flex size-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <span className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-950">
              <Logo size={20} /> Daily Networker
            </span>
          )}
          {index > 0 && (
            <>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/70">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-ink-600 transition-[width] duration-500"
                  style={{ width: `${Math.min(100, (index / (STEPS + 1)) * 100)}%` }}
                />
              </div>
              <span className="w-9 text-right text-xs font-medium tabular-nums text-slate-400">
                {index <= STEPS ? `${index}/${STEPS}` : ""}
              </span>
            </>
          )}
          {/* Skippable: answers saved so far are kept; finish later from the Me tab. */}
          {step !== "enrich" && (
            <button
              type="button"
              onClick={() => startSaving(() => completeOnboardingAction())}
              disabled={saving}
              className="ml-auto shrink-0 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-white hover:text-slate-800 disabled:opacity-60"
            >
              Skip for now
            </button>
          )}
        </div>

        <div key={step} className={`mt-8 flex flex-col gap-6 ${back ? "animate-[rise_.4s_ease_both]" : "animate-rise"}`}>
          {step === "welcome" && <Welcome />}
          {step === "business" && (
            <Section eyebrow="Step 1 · Your business" title="What do you offer?" lead="We use this to recognize who needs you and to write messages that sound like you. Pick all that apply.">
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Your name</span>
                <input
                  value={p.full_name ?? ""}
                  onChange={(e) => set("full_name", e.target.value)}
                  placeholder="e.g. Alex Rivera"
                  autoComplete="name"
                  maxLength={80}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm outline-none transition placeholder:text-slate-400 focus:border-ink-500 focus:ring-4 focus:ring-ink-100"
                />
                <span className="block text-xs text-slate-500">Drafted messages are signed with your first name.</span>
              </label>
              <Chips
                options={OFFERS.map(([id, label]) => [id, label])}
                selected={p.offers}
                onChange={(v) => set("offers", v)}
              />
              <label className="space-y-1.5">
                <span className="flex justify-between text-sm font-semibold text-slate-700">
                  In one line <span className="font-normal text-slate-400">optional</span>
                </span>
                <input
                  value={p.offer_line ?? ""}
                  onChange={(e) => set("offer_line", e.target.value)}
                  placeholder="e.g. Fractional CMO for B2B service firms"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm outline-none transition placeholder:text-slate-400 focus:border-ink-500 focus:ring-4 focus:ring-ink-100"
                />
              </label>
            </Section>
          )}
          {step === "clients" && (
            <Section eyebrow="Step 2 · Ideal clients" title="Who are you trying to reach?" lead="Optional. Skip anything that doesn't apply.">
              <Group label="Industry">
                <Chips options={INDUSTRIES.map((x) => [x, x])} selected={p.industries} onChange={(v) => set("industries", v)} />
              </Group>
              <Group label="Their role">
                <Chips options={ROLES.map(([id, l]) => [id, l])} selected={p.roles} onChange={(v) => set("roles", v)} />
              </Group>
              <Group label="Company size (annual revenue)">
                <Chips
                  options={REVENUE.map(([id, l]) => [id, l])}
                  selected={p.revenue}
                  exclusive="any"
                  onChange={(v) => set("revenue", v)}
                />
              </Group>
            </Section>
          )}
          {step === "cadence" && (
            <Section eyebrow="Step 3 · Reach-out rhythm" title="How much time do you have for your network?" lead="Pick a pace. You can change it any time on the Me page.">
              <div className="grid gap-2.5 sm:grid-cols-3">
                {PACES.map((pace) => {
                  const on = p.per_day === pace.per_day && p.rest_days === pace.rest_days;
                  return (
                    <button
                      key={pace.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setP((prev) => ({ ...prev, per_day: pace.per_day, rest_days: pace.rest_days }))}
                      className={`rounded-2xl border p-4 text-left transition ${
                        on ? "border-ink-500 bg-ink-50 ring-4 ring-ink-100" : "border-slate-200 bg-white shadow-sm hover:border-slate-300"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{pace.name}</span>
                        {pace.recommended && <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-semibold text-ink-800">Recommended</span>}
                      </span>
                      <span className="mt-1 block text-sm text-slate-600">{pace.per_day} people a day</span>
                      <span className="block text-xs text-slate-500">{pace.sub}</span>
                    </button>
                  );
                })}
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
              <details className="group rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-900">Fine-tune</summary>
                <div className="mt-4 space-y-5">
                  <Slider label="People per day" value={p.per_day} min={1} max={10} format={(v) => `${v} ${v === 1 ? "person" : "people"}`} onChange={(v) => set("per_day", v)} />
                  <Slider label="Rest after reaching out" value={p.rest_days} min={3} max={60} format={(v) => `${v} days`} onChange={(v) => set("rest_days", v)} hint="Nobody shows up again until this many days have passed." />
                </div>
              </details>
            </Section>
          )}
          {step === "upload" && (
            <Section eyebrow="Step 4 · Contacts" title="Add your contacts">
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) readFile(f);
                }}
                className={`${card} flex cursor-pointer flex-col items-center gap-3 border-dashed p-7 text-center transition hover:border-ink-300 ${source === "csv" ? "border-ink-400 ring-4 ring-ink-100" : ""}`}
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-ink-50 text-ink-700">
                  {source === "csv" ? <FileSpreadsheet className="size-6" /> : <Upload className="size-6" />}
                </span>
                <span>
                  <span className="block font-semibold text-slate-900">{csv ? csv.fileName : "Upload a CSV"}</span>
                  <span className="text-sm text-slate-500">
                    {csv?.linkedin
                      ? `${contacts.length} LinkedIn connections${
                          csv.linkedin.total > contacts.length ? ` (your most recent, of ${csv.linkedin.total})` : ""
                        }`
                      : csv
                        ? `${contacts.length} people · ${withNotes} with notes`
                        : "Name, company, title, relationship and your notes. Notes are where intros come from."}
                  </span>
                </span>
                <span className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold ${btn.secondary}`}>{csv ? "Choose another file" : "Choose file"}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readFile(f);
                    e.target.value = "";
                  }}
                />
              </label>

              {!csv && (
                <p className="text-center text-xs leading-relaxed text-slate-500">
                  On LinkedIn? Export your connections from{" "}
                  <a href={LINKEDIN_EXPORT_URL} target="_blank" rel="noreferrer" className="font-medium text-ink-700 underline-offset-2 hover:underline">
                    Settings → Data privacy → Get a copy of your data
                  </a>{" "}
                  (choose Connections) and upload Connections.csv as is.
                </p>
              )}

              <div className="flex flex-col items-center gap-1 text-sm">
                {!hasDemo && (
                  <ChoiceLink on={source === "demo"} onClick={() => pickSource("demo")}>
                    Or try the demo network (35 people)
                  </ChoiceLink>
                )}
                {existingContacts > 0 && (
                  <ChoiceLink on={source === "existing"} onClick={() => pickSource("existing")}>
                    Keep my {existingContacts} existing contacts
                  </ChoiceLink>
                )}
              </div>

              {uploadError && (
                <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> {uploadError}
                </p>
              )}

              {source === "csv" && csv && map && (
                <>
                  <Group label="Match your columns">
                    <div className={`${card} divide-y divide-slate-100`}>
                      {FIELDS.map((f) => (
                        <div key={f.key} className="grid grid-cols-[8.5rem_1fr] items-center gap-3 px-4 py-2.5 text-sm">
                          <span className="font-medium text-slate-700">
                            {f.label}
                            {"required" in f && " *"}
                          </span>
                          <select
                            value={map[f.key]}
                            onChange={(e) => {
                              const next = { ...map, [f.key]: Number(e.target.value) };
                              setMap(next);
                              if (f.key === "status") setLabels(statusLabels(csv, next.status));
                            }}
                            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none focus:border-ink-500"
                          >
                            <option value={-1}>— not in file —</option>
                            {csv.header.map((h, i) => (
                              <option key={i} value={i}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </Group>
                  {Object.keys(labels).length > 0 && (
                    <Group label="How your relationship labels map">
                      <div className={`${card} divide-y divide-slate-100`}>
                        {Object.entries(labels).map(([label, w]) => (
                          <div key={label} className="grid grid-cols-[minmax(0,1fr)_13rem] items-center gap-3 px-4 py-2.5 text-sm">
                            <span className="truncate text-slate-700">“{label}”</span>
                            <Segmented
                              small
                              options={WARMTH.map((x) => [x.id, x.label])}
                              value={w}
                              onChange={(v) => setLabels({ ...labels, [label]: v as Warmth })}
                            />
                          </div>
                        ))}
                      </div>
                    </Group>
                  )}
                  {map.status < 0 && <p className="text-xs text-slate-500">No relationship column, so everyone starts as Warm. You can change it per contact later.</p>}
                  {!contacts.length && <p className="text-sm text-red-700">No rows have a name. Pick the column that holds names.</p>}
                  {webEnrichment && (
                    <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-sm shadow-sm">
                      <input type="checkbox" checked={lookupWeb} onChange={(e) => setLookupWeb(e.target.checked)} className="mt-0.5 size-4 accent-ink-600" />
                      <span>
                        <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                          <Globe className="size-4 text-ink-600" /> Look people up on the public web
                        </span>
                        <span className="text-slate-500">Searches each person&apos;s name, title and company to add recent news. Notes never leave Daily Networker for this.</span>
                      </span>
                    </label>
                  )}
                </>
              )}
              <p className="text-xs leading-relaxed text-slate-400">
                Your contacts are private to your account. Notes are sent to Claude to find needs and offers; nothing is ever sent to your contacts without you.
              </p>
            </Section>
          )}
          {step === "enrich" && (
            <Section
              eyebrow="Getting to know your network"
              title={summary ? "Your network is ready" : runError ? "That didn't finish" : "Enriching your contacts"}
            >
              <ol className="space-y-3.5">
                {STAGES.map((label, i) => {
                  const done = stage > i;
                  const on = stage === i && !runError;
                  return (
                    <li key={label} className="flex items-center gap-3">
                      <span
                        className={`flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition ${
                          done ? "border-ink-600 bg-ink-600 text-white" : on ? "border-ink-500 text-ink-600" : "border-slate-200 text-transparent"
                        }`}
                      >
                        {done ? <Check className="size-4" strokeWidth={3} /> : on ? <LoaderCircle className="size-4 animate-spin" /> : null}
                      </span>
                      <span className={`text-[15px] ${on ? "font-semibold text-slate-900" : done ? "text-slate-700" : "text-slate-400"}`}>{label}</span>
                    </li>
                  );
                })}
              </ol>
              {stageMsg && !runError && <p className="text-sm text-slate-500">{stageMsg}</p>}
              {runError && (
                <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> {runError}. Anything already saved is kept, so trying again picks up where it left off.
                </p>
              )}
              {summary && (
                <div className="animate-rise space-y-5">
                  <div className="grid grid-cols-3 gap-2.5">
                    <Stat value={summary.contacts} label="contacts" />
                    <Stat value={summary.needs} label="needs found" />
                    <Stat value={summary.intros} label="intro ideas" />
                  </div>
                  <div className="space-y-2.5">
                    <h3 className="flex items-center gap-1.5 font-semibold text-slate-900">
                      <Sparkles className="size-4 text-ink-600" /> Intros you could make
                    </h3>
                    {summary.top.length ? (
                      summary.top.map((t) => (
                        <div key={t.recipient + t.proposed} className={`${card} flex items-start gap-3 p-4`}>
                          <span className="flex -space-x-3">
                            <Avatar name={t.recipient} size="sm" />
                            <Avatar name={t.proposed} size="sm" />
                          </span>
                          <span className="min-w-0 text-sm">
                            <span className="block font-semibold text-slate-900">
                              {t.recipient} <span className="font-normal text-slate-400">←</span> {t.proposed}
                            </span>
                            <span className="mt-1 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-900 ring-1 ring-inset ring-violet-200/70">
                              {t.need}
                            </span>
                            <span className="mt-1 block text-slate-500">{t.why}</span>
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className={`${card} p-4 text-sm text-slate-500`}>
                        No clear intros yet. Notes that say what people need and what they can offer produce better matches. Add a few after your next conversations.
                      </p>
                    )}
                  </div>
                  {summary.enriched > 0 && (
                    <p className="flex items-center gap-1.5 text-sm text-slate-500">
                      <Globe className="size-4" /> {summary.enriched} people matched to public web profiles.
                    </p>
                  )}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>

      {/* Bottom dock */}
      {cta && (
        <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[#f8f9fc] via-[#f8f9fc] to-transparent px-5 pb-6 pt-10">
          <div className="mx-auto max-w-xl">
            <button
              type="button"
              onClick={cta.onClick}
              disabled={cta.disabled || saving}
              className={`flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-base font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${btn.primary}`}
            >
              {saving ? <LoaderCircle className="size-5 animate-spin" /> : cta.label}
              {!saving && step !== "enrich" && <ArrowRight className="size-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  function pickSource(s: "demo" | "existing") {
    setSource(s);
    setCsv(null);
    setMap(null);
    setUploadError(null);
  }

  function readFile(f: File) {
    f.text().then((text) => {
      const parsed = parseCsv(f.name, text);
      if ("error" in parsed) {
        setUploadError(parsed.error);
        return;
      }
      const m = guessColumns(parsed.header);
      setUploadError(m.name < 0 ? "We couldn't find a name column. Pick it below." : null);
      setCsv(parsed);
      setMap(m);
      setLabels(statusLabels(parsed, m.status));
      setSource("csv");
    });
  }
}

// ---------- Pieces ----------

function Welcome() {
  return (
    <>
      <div className="space-y-4">
        <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-slate-950">Your network, one valuable intro a day.</h1>
        <p className="text-base text-slate-500">
          Tell us what you offer and who you want to help. Daily Networker reads your notes, spots introductions you can make, and drafts the message. You decide what gets sent.
        </p>
      </div>
      <div aria-hidden className="space-y-2.5">
        <PreviewCard name="Sarah Chen" score={92} tag="Make an intro" why="Needs digital health seed investors. Michael Reed just closed a new fund." className="-rotate-1" />
        <PreviewCard name="Grace Liu" score={88} tag="Two-way value" why="Evaluating routing software this quarter. Tom Becker sells exactly that." className="rotate-1 opacity-80" />
      </div>
      <ol className="space-y-3 text-sm text-slate-700">
        {[
          "Answer three quick questions. Mostly taps, very little typing.",
          "Upload a CSV of contacts with your notes, or try the demo network.",
          "Get today's introductions with drafted messages, ready to copy or skip.",
        ].map((t, i) => (
          <li key={t} className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-50 text-xs font-bold text-ink-700">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
    </>
  );
}

function PreviewCard({ name, score, tag, why, className }: { name: string; score: number; tag: string; why: string; className: string }) {
  return (
    <div className={`${card} flex items-start gap-3 p-4 ${className}`}>
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-slate-900">{name}</span>
          <span className="text-lg font-bold tabular-nums text-ink-800">{score}</span>
        </div>
        <span className="inline-block rounded-md bg-ink-50 px-2 py-0.5 text-xs font-semibold text-ink-700">{tag}</span>
        <p className="mt-1 text-sm text-slate-500">{why}</p>
      </div>
    </div>
  );
}

function Section({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">{eyebrow}</p>
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-slate-950">{title}</h2>
        {lead && <p className="text-sm text-slate-500">{lead}</p>}
      </div>
      {children}
    </>
  );
}

export function Group({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="text-sm font-semibold text-slate-700">{label}</div>
      {children}
    </div>
  );
}

export function Chips({
  options,
  selected,
  onChange,
  exclusive,
}: {
  options: (readonly [string, string])[];
  selected: string[];
  onChange: (next: string[]) => void;
  exclusive?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([id, label]) => {
        const on = selected.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              let next = on ? selected.filter((x) => x !== id) : [...selected, id];
              if (exclusive) {
                next = id === exclusive && !on ? [exclusive] : next.filter((x) => x !== exclusive);
                if (!next.length) next = [exclusive];
              }
              onChange(next);
            }}
            className={`rounded-full border px-3.5 py-2 text-sm transition ${
              on ? "border-ink-500 bg-ink-50 font-semibold text-ink-900" : "border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300"
            }`}
          >
            {on && <Check className="-ml-0.5 mr-1 inline size-3.5" strokeWidth={3} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-semibold text-slate-700">{label}</span>
        <span className="font-semibold tabular-nums text-ink-700">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 w-full accent-ink-600"
      />
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  small = false,
}: {
  options: (readonly [string, string])[];
  value: string;
  onChange: (v: string) => void;
  small?: boolean;
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`flex-1 rounded-lg ${small ? "px-1.5 py-1 text-xs" : "px-3 py-2 text-sm"} transition ${
            value === id ? "bg-white font-semibold text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ChoiceLink({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-semibold transition ${on ? "bg-ink-50 text-ink-800" : "text-ink-600 hover:bg-ink-50/60"}`}
    >
      {on && <Check className="size-4" strokeWidth={3} />}
      {children}
    </button>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className={`${card} flex flex-col gap-0.5 p-3.5`}>
      <span className="text-2xl font-bold tabular-nums text-slate-950">{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}
