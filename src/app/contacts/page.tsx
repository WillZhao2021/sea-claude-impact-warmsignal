import Link from "next/link";
import { ChevronRight, Globe, Sparkles, Wand2 } from "lucide-react";
import { enrichAllAction, loadDemoAction, removeDemoAction } from "@/app/actions";
import { ImportCsvForm } from "@/components/import-csv-form";
import { AttributeChips, GoalFitChip } from "@/components/enrichment-view";
import { PhonebookImport } from "@/components/phonebook-import";
import { SubmitButton } from "@/components/submit-button";
import { Avatar, btn, card, Chip, formatDate, MoveTag, PageHeader, SignalBars } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { defaultEvalDate } from "@/lib/briefing";
import { hasDemoData } from "@/lib/demo";
import { buildMoves } from "@/lib/moves";
import { must } from "@/lib/supabase";
import type { Contact } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const ctx = await requireCtx();
  const supabase = ctx.db;
  const [contacts, signals, demoLoaded, { moves }] = await Promise.all([
    supabase.from("contacts").select("*").eq("owner_id", ctx.ownerId).order("name").then((r) => must<Contact[]>(r)),
    supabase
      .from("signals")
      .select("contact_id, type")
      .eq("owner_id", ctx.ownerId)
      .eq("status", "active")
      .then((r) => must<{ contact_id: string; type: string }[]>(r)),
    hasDemoData(ctx),
    buildMoves(ctx, defaultEvalDate()),
  ]);
  const counts = (id: string, type: string) => signals.filter((s) => s.contact_id === id && s.type === type).length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Your network"
        title={`${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}`}
        subtitle="Everyone you could help, and everyone who could help someone else."
        actions={
          <>
            <form action={demoLoaded ? removeDemoAction : loadDemoAction}>
              <SubmitButton pendingText={demoLoaded ? "Removing…" : "Loading…"} className={btn.secondary}>
                {!demoLoaded && <Sparkles className="size-4" />}
                {demoLoaded ? "Remove demo contacts" : "Load demo contacts"}
              </SubmitButton>
            </form>
            <form action={enrichAllAction}>
              <SubmitButton pendingText="Enriching…" className={btn.secondary}>
                <Wand2 className="size-4" /> Enrich new
              </SubmitButton>
            </form>
          </>
        }
      />

      <ImportCsvForm />

      <PhonebookImport />

      <div className={`${card} overflow-hidden`}>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
            <tr>
              <th className="w-full px-4 py-3 font-medium sm:px-5">Name</th>
              <th className="hidden px-3 py-3 font-medium md:table-cell">Relationship</th>
              <th className="hidden whitespace-nowrap px-3 py-3 font-medium sm:table-cell">Last spoke</th>
              <th className="px-3 py-3 font-medium">Signals</th>
              <th className="hidden px-3 py-3 font-medium lg:table-cell">Web</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {contacts.map((c) => {
              const needs = counts(c.id, "need");
              const offers = counts(c.id, "offer");
              return (
                <tr key={c.id} className="group relative transition hover:bg-ink-50/40">
                  {/* w-full + max-w-0 lets the title truncate instead of widening the table past its card. */}
                  <td className="w-full max-w-0 px-4 py-3 sm:px-5">
                    <div className="flex items-center gap-3">
                      <Avatar name={c.name} size="md" />
                      <div className="min-w-0">
                        <Link href={`/contacts/${c.id}`} className="block truncate font-semibold text-slate-900 after:absolute after:inset-0">
                          {c.name}
                        </Link>
                        <div className="truncate text-slate-500">{[c.title, c.company].filter(Boolean).join(", ")}</div>
                        {moves.has(c.id) && (
                          <div className="mt-1 flex">
                            <MoveTag move={moves.get(c.id)!} withWhy />
                          </div>
                        )}
                        {c.enrichment?.status === "matched" && !!c.enrichment.attributes?.length && (
                          <div className="mt-1">
                            <AttributeChips attributes={c.enrichment.attributes} max={3} />
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-3 md:table-cell">
                    <SignalBars value={c.relationship_strength} />
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-slate-500 sm:table-cell">{formatDate(c.last_interaction_date)}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1 whitespace-nowrap xl:flex-nowrap">
                      {needs > 0 && <Chip tone="violet">{needs} need{needs > 1 && "s"}</Chip>}
                      {offers > 0 && <Chip tone="sky">{offers} offer{offers > 1 && "s"}</Chip>}
                      <GoalFitChip fit={c.enrichment?.network?.goal_fit} />
                      {needs + offers === 0 && !c.enrichment?.network?.goal_fit && <span className="text-slate-300">—</span>}
                    </div>
                  </td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    {!c.enrichment ? (
                      <span className="text-slate-300">—</span>
                    ) : c.enrichment.status === "matched" ? (
                      <Chip tone="emerald">
                        <Globe className="size-3" /> enriched
                      </Chip>
                    ) : (
                      <Chip tone="slate">no match</Chip>
                    )}
                  </td>
                  <td className="pr-4">
                    <ChevronRight className="size-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-ink-500" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {contacts.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-slate-500">No contacts yet. Add one, import a CSV, or load the demo.</p>
        )}
      </div>
    </div>
  );
}
