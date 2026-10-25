import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Clock,
  HandHeart,
  Mail,
  MessageCircle,
  Hand,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { addNoteAction } from "@/app/actions";
import { EnrichPanel } from "@/components/enrich-panel";
import { AttributeChips, EnrichmentView, GoalFitChip } from "@/components/enrichment-view";
import { DictationTextarea } from "@/components/dictation";
import { SubmitButton } from "@/components/submit-button";
import { Avatar, btn, card, Chip, formatDate, input, MoveTag, SignalBars } from "@/components/ui";
import { defaultEvalDate } from "@/lib/briefing";
import { requireCtx } from "@/lib/auth";
import { REFRESH_AFTER_DAYS } from "@/lib/enrich";
import { buildMoves } from "@/lib/moves";
import { whatsappLink } from "@/lib/phonebook";
import { must } from "@/lib/supabase";
import type { Contact, Interaction, Signal } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function ContactPage({ params }: PageProps<"/contacts/[id]">) {
  const { id } = await params;
  const ctx = await requireCtx();
  const supabase = ctx.db;
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("owner_id", ctx.ownerId)
    .eq("id", id)
    .maybeSingle<Contact>();
  if (!contact) notFound();

  const [interactions, signals, { moves }] = await Promise.all([
    supabase
      .from("interactions")
      .select("*")
      .eq("owner_id", ctx.ownerId)
      .eq("contact_id", id)
      .order("date", { ascending: false })
      .then((r) => must<Interaction[]>(r)),
    supabase
      .from("signals")
      .select("*")
      .eq("owner_id", ctx.ownerId)
      .eq("contact_id", id)
      .then((r) => must<Signal[]>(r)),
    buildMoves(ctx, defaultEvalDate()),
  ]);
  const move = moves.get(contact.id);

  return (
    <div className="space-y-6">
      <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft className="size-4" /> Contacts
      </Link>

      <section className={`${card} flex flex-wrap items-center gap-6 p-6`}>
        <Avatar name={contact.name} size="xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">{contact.name}</h1>
          <p className="text-slate-500">{[contact.title, contact.company].filter(Boolean).join(", ")}</p>
          {move && (
            <p className="flex">
              <MoveTag move={move} withWhy />
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            {contact.industry && (
              <Chip tone="slate">
                <Building2 className="size-3" /> {contact.industry}
              </Chip>
            )}
            <Chip tone="slate">
              <SignalBars small value={contact.relationship_strength} /> Relationship {contact.relationship_strength}/5
            </Chip>
            <Chip tone="slate">
              <Clock className="size-3" /> Last spoke {formatDate(contact.last_interaction_date)}
            </Chip>
            <GoalFitChip fit={contact.enrichment?.network?.goal_fit} showNone />
            {contact.phone && (
              <a href={whatsappLink(contact.phone)} target="_blank" rel="noreferrer" title="Open a WhatsApp chat">
                <Chip tone="emerald">
                  <MessageCircle className="size-3" /> WhatsApp {contact.phone}
                </Chip>
              </a>
            )}
            {contact.email && (
              <a href={`mailto:${contact.email}`}>
                <Chip tone="slate">
                  <Mail className="size-3" /> {contact.email}
                </Chip>
              </a>
            )}
          </div>
          {contact.enrichment?.status === "matched" && !!contact.enrichment.attributes?.length && (
            <AttributeChips attributes={contact.enrichment.attributes} />
          )}
        </div>
        {contact.introduction_preferences && (
          <div className="flex w-full items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200/70">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              <span className="font-semibold">Intro preferences:</span> {contact.introduction_preferences}
            </span>
          </div>
        )}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <form action={addNoteAction} className={`${card} space-y-3 p-6`}>
            <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <MessageSquareText className="size-5 text-ink-500" /> Log a conversation
            </h2>
            <input type="hidden" name="contact_id" value={contact.id} />
            <DictationTextarea
              name="notes"
              required
              rows={5}
              placeholder={`What did you learn from ${contact.name.split(" ")[0]}? Goals, challenges, what they're looking for, what they could offer others… (or tap the mic and say it)`}
              className={`${input} leading-relaxed`}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <input type="date" name="date" defaultValue={defaultEvalDate()} className={`${input} !w-auto`} />
              <SubmitButton pendingText="Extracting with Claude…" className={btn.primary}>
                <Sparkles className="size-4" /> Save &amp; extract
              </SubmitButton>
            </div>
          </form>

          <section className="space-y-4">
            <h2 className="text-lg font-bold tracking-tight">
              Conversations <span className="font-medium text-slate-400">{interactions.length}</span>
            </h2>
            {interactions.length === 0 && (
              <p className={`${card} px-6 py-10 text-center text-sm text-slate-500`}>No conversations logged yet.</p>
            )}
            <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-slate-200">
              {interactions.map((it) => {
                const mine = signals.filter((s) => s.interaction_id === it.id);
                return (
                  <li key={it.id} className="relative flex gap-4">
                    <span className="z-0 mt-5 flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-ink-500 shadow-sm ring-1 ring-slate-200">
                      <CalendarDays className="size-4" />
                    </span>
                    <article className={`${card} min-w-0 flex-1 p-5 text-sm`}>
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">{formatDate(it.date)}</div>
                      <p className="mt-2 whitespace-pre-wrap leading-relaxed text-slate-700">{it.raw_notes}</p>
                      {it.context?.summary && (
                        <p className="mt-3 rounded-lg bg-ink-50/60 px-3 py-2 text-ink-900">
                          <Sparkles className="mr-1.5 inline size-3.5 text-ink-500" />
                          {it.context.summary}
                        </p>
                      )}
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <SignalList title="Needs" tone="violet" items={mine.filter((s) => s.type === "need")} />
                        <SignalList title="Offers" tone="sky" items={mine.filter((s) => s.type === "offer")} />
                      </div>
                      {!!it.context?.uncertainties?.length && (
                        <div className="mt-4">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Uncertain / sensitive</h3>
                          <ul className="mt-1 list-disc pl-5 text-slate-600">
                            {it.context.uncertainties.map((u) => (
                              <li key={u}>{u}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <WebProfile contact={contact} />
      </div>
    </div>
  );
}

function SignalList({ title, tone, items }: { title: string; tone: "violet" | "sky"; items: Signal[] }) {
  const Icon = tone === "violet" ? Hand : HandHeart;
  return (
    <div>
      <h3 className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${tone === "violet" ? "text-violet-600" : "text-sky-600"}`}>
        <Icon className="size-3.5" /> {title}
      </h3>
      {items.length === 0 && <p className="mt-2 text-slate-400">None stated</p>}
      <ul className="mt-2 space-y-2">
        {items.map((s) => (
          <li key={s.id} className={`rounded-xl p-3 ring-1 ring-inset ${tone === "violet" ? "bg-violet-50/50 ring-violet-100" : "bg-sky-50/50 ring-sky-100"}`}>
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-slate-900">{s.description}</span>
              <span className="shrink-0 font-mono text-xs text-slate-400">{Math.round(s.confidence * 100)}%</span>
            </div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500">“{s.supporting_text}”</div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Chip tone="slate">{s.category}</Chip>
              {s.is_inferred && <Chip tone="amber">inferred</Chip>}
              {!s.quote_verified && <Chip tone="amber">not verbatim</Chip>}
              {s.time_sensitive && <Chip tone="slate">time-sensitive</Chip>}
              {s.relevant_until && <Chip tone="slate">until {s.relevant_until}</Chip>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebProfile({ contact }: { contact: Contact }) {
  return (
    <EnrichPanel contactId={contact.id} name={contact.name} enriched={!!contact.enriched_at}>
      <EnrichmentView enrichment={contact.enrichment} name={contact.name} />
      {contact.enriched_at && (
        <p className="mt-4 text-xs text-slate-400">
          Checked {contact.enriched_at.slice(0, 10)} · refreshes every {REFRESH_AFTER_DAYS} days
        </p>
      )}
    </EnrichPanel>
  );
}
