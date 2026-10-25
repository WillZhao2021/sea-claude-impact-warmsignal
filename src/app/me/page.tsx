import Link from "next/link";
import { ArrowRight, LogOut, RotateCcw, Sparkles } from "lucide-react";
import { signOutAction } from "@/app/actions";
import { ProfileForm } from "@/components/me/profile-form";
import { btn, card, formatDate, PageHeader } from "@/components/ui";
import { requireCtx } from "@/lib/auth";
import { DEFAULT_PROFILE, getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const ctx = await requireCtx();
  const [profile, contacts] = await Promise.all([
    getProfile(ctx),
    ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("owner_id", ctx.ownerId),
  ]);
  // Skipping onboarding also sets onboarded_at; without any answers, treat it as not set up yet.
  const onboarded = Boolean(profile?.onboarded_at) && Boolean(profile?.offers.length || profile?.goal);
  const email = ctx.email ?? "Your account";

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Your account" title="Me" subtitle="What you offer, who you want to reach, and how Daily Networker works for you." />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.4fr]">
        <section className={`${card} flex min-w-0 items-center gap-4 p-5`}>
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-ink-600 text-lg font-semibold text-white">
            {email[0]!.toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-slate-900" title={email}>
              {email}
            </div>
            <div className="text-xs text-slate-500">
              {contacts.count ?? 0} contacts
              {onboarded && ` · set up ${formatDate(profile!.onboarded_at!.slice(0, 10))}`}
            </div>
          </div>
          <form action={signOutAction}>
            <button type="submit" title="Sign out" className={`rounded-lg p-2 ${btn.ghost}`}>
              <LogOut className="size-4" />
            </button>
          </form>
        </section>

        <section className="relative min-w-0 overflow-hidden rounded-2xl bg-ink-900 p-5 text-white shadow-card-lg">
          <div aria-hidden className="absolute -right-10 -top-16 size-48 rounded-full bg-indigo-400/30 blur-3xl" />
          <div className="relative flex flex-wrap items-center gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/10">
              {onboarded ? <RotateCcw className="size-5" /> : <Sparkles className="size-5" />}
            </span>
            <div className="min-w-[12rem] flex-1">
              <div className="font-semibold">{onboarded ? "Run onboarding again" : "Finish setting up"}</div>
              <p className="text-sm text-indigo-100/75">
                {onboarded
                  ? "Walk through the guided setup with your answers prefilled, or import more contacts. Nothing is duplicated."
                  : "A few questions and your contacts, then Daily Networker builds your first briefing."}
              </p>
            </div>
            <Link
              href="/onboarding"
              className="group inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-ink-900 transition hover:bg-indigo-50"
            >
              {onboarded ? "Start onboarding" : "Continue setup"}
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </Link>
          </div>
        </section>
      </div>

      <ProfileForm initial={{ ...DEFAULT_PROFILE, ...profile }} />
    </div>
  );
}
