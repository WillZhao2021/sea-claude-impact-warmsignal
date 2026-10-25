import Link from "next/link";
import { CatchUpDeck } from "@/components/catch-up-deck";
import { btn, card, PageHeader } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { defaultEvalDate } from "@/lib/briefing";
import { buildCatchUpDeck, SNOOZE_DAYS } from "@/lib/catch-up";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function CatchUpPage({ searchParams }: PageProps<"/catch-up">) {
  const { date } = await searchParams;
  const evalDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : defaultEvalDate();
  const ctx = await requireCtx();
  const { count } = await ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Keep warm"
        title="Stay close to your people"
        subtitle="People you know well but haven't seen in a while. No agenda, just a check-in: swipe right to suggest meeting up. Anyone you have a reason to contact is on Today instead."
      />
      {count ? (
        <CatchUpDeck cards={await buildCatchUpDeck(ctx, evalDate)} evalDate={evalDate} snoozeDays={SNOOZE_DAYS} />
      ) : (
        <div className={`${card} mx-auto max-w-md px-6 py-12 text-center`}>
          <p className="text-sm text-slate-500">Add some contacts first, then come back to keep in touch with them.</p>
          <Link href="/" className={`mt-5 inline-flex rounded-lg px-3.5 py-2 text-sm font-medium ${btn.primary}`}>
            Get started
          </Link>
        </div>
      )}
    </div>
  );
}
