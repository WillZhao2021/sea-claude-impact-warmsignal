import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRight,
  ArrowRight,
  BadgeCheck,
  Gauge,
  Handshake,
  ListChecks,
  MessageSquareText,
  ScanSearch,
  Send,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { NetworkScene } from "@/components/landing/network-scene";
import { Avatar, Logo } from "@/components/ui";

export const metadata: Metadata = {
  title: "Daily Networker: be the person who always has something valuable to give",
  description:
    "Daily Networker reads your conversation notes, spots who in your network can help whom, and hands you a short list of introductions every morning, with the message already drafted.",
};

export default function WelcomePage() {
  return (
    <div className="bg-white text-slate-900">
      <Hero />
      <HowItWorks />
      <Principles />
      <ClosingCta />
      <footer className="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
        Daily Networker · Relationship intelligence, powered by Claude
      </footer>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-[#08071d] text-white">
      {/* Atmosphere behind the 3D network */}
      <div aria-hidden className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_70%_at_70%_40%,#2a2475_0%,#120f3a_45%,#08071d_80%)]" />
        <div className="absolute right-[10%] top-[30%] size-[420px] rounded-full bg-orange-400/10 blur-[120px]" />
      </div>
      <NetworkScene className="absolute inset-x-0 bottom-0 top-[30%] -z-10 lg:inset-y-0 lg:left-[28%]" />
      {/* Keeps the headline legible over the scene on small screens */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-[#08071d]/80 via-[#08071d]/30 to-transparent lg:bg-gradient-to-r lg:from-[#08071d] lg:via-[#08071d]/30" />

      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/welcome" className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
          <Logo /> Daily Networker
        </Link>
        <div className="flex items-center gap-1 whitespace-nowrap text-sm font-medium sm:gap-2">
          <Link href="/login" className="rounded-lg px-3.5 py-2 text-white/75 transition hover:bg-white/10 hover:text-white">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-white px-3.5 py-2 text-ink-900 shadow-sm transition hover:bg-indigo-50"
          >
            Get started
          </Link>
        </div>
      </nav>

      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-24 pt-16 sm:pt-24 lg:min-h-[640px] lg:grid-cols-[1.1fr_1fr] lg:pb-32">
        <div className="animate-rise">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-indigo-100 backdrop-blur">
            <Sparkles className="size-3.5 text-orange-300" /> Relationship intelligence, powered by Claude
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Be the person who always has{" "}
            <span className="bg-gradient-to-r from-indigo-200 via-violet-200 to-orange-200 bg-clip-text text-transparent">
              something valuable to give.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-indigo-100/75">
            Daily Networker reads your conversation notes, spots who in your network can help whom, and hands you a short list
            of introductions every morning, with the message already drafted.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-ink-900 shadow-lg shadow-indigo-950/40 transition hover:bg-indigo-50"
            >
              Get started
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/10"
            >
              Sign in
            </Link>
            <span className="text-xs text-indigo-100/50">Invite-only pilot</span>
          </div>
        </div>

        <PreviewCard />
      </div>
    </section>
  );
}

/** A real-looking briefing card floating over the network, so the payoff is visible above the fold. */
function PreviewCard() {
  return (
    <div className="relative hidden animate-rise justify-self-end [animation-delay:250ms] lg:block">
      <div className="w-[420px] rotate-[-2deg] rounded-2xl border border-white/15 bg-white/[0.07] p-5 shadow-2xl shadow-black/40 backdrop-blur-xl transition duration-500 hover:rotate-0">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-white/10 text-sm font-bold">1</span>
          <span className="flex-1 font-semibold">Introduce Olivia to Ben</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold">
            <TrendingUp className="size-3.5 text-orange-300" /> 92 <span className="text-white/50">/ 100</span>
          </span>
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-white/[0.06] p-3">
          <Avatar name="Olivia Martinez" size="md" />
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-semibold">Olivia Martinez</div>
            <div className="truncate text-white/60">Needs a B2B podcast agency</div>
          </div>
          <ArrowLeftRight className="size-4 shrink-0 text-indigo-200" />
          <div className="min-w-0 flex-1 text-right text-xs">
            <div className="font-semibold">Ben Carter</div>
            <div className="truncate text-white/60">Runs one</div>
          </div>
          <Avatar name="Ben Carter" size="md" />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-white/70">
          <span className="font-semibold text-white">Why now:</span> January launch; Ben&apos;s fall capacity may fill.
        </p>
        <div className="mt-4 rounded-xl bg-white/[0.06] p-3 text-xs leading-relaxed text-white/75">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-white/50">
            <MessageSquareText className="size-3" /> Draft to Olivia
          </div>
          Hi Olivia, you mentioned you&apos;re looking for a podcast agency that really gets B2B. I know a founder whose
          studio does exactly that…
        </div>
        <div className="mt-4 flex gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-ink-900">
            <Send className="size-3" /> Olivia said yes
          </span>
          <span className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white/80">Not now</span>
        </div>
      </div>
      <div className="absolute -bottom-6 -left-10 flex items-center gap-2 rounded-xl border border-white/15 bg-[#120f3a]/80 px-3 py-2 text-xs shadow-xl backdrop-blur-xl">
        <BadgeCheck className="size-4 text-emerald-300" />
        <span className="text-white/80">Quote found verbatim in your notes</span>
      </div>
    </div>
  );
}

const STEPS = [
  {
    icon: MessageSquareText,
    title: "Log the conversation",
    body: "Jot down what you learned over coffee, the way you already do. Or import your contacts from a CSV.",
  },
  {
    icon: ScanSearch,
    title: "Claude finds needs and offers",
    body: "Every need and offer is pulled out with the exact quote it came from, so nothing is made up.",
  },
  {
    icon: ListChecks,
    title: "Get your morning briefing",
    body: "Up to five ranked introductions, each with the reasoning, the timing and a drafted message.",
  },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading eyebrow="How it works" title="From scattered notes to the right introduction" />
      <ol className="mt-14 grid gap-6 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className="group relative rounded-2xl border border-slate-200/80 bg-white p-6 shadow-card transition hover:-translate-y-1 hover:shadow-card-lg"
          >
            <div className="flex items-center justify-between">
              <span className="flex size-11 items-center justify-center rounded-xl bg-ink-50 text-ink-600 transition group-hover:bg-ink-900 group-hover:text-white">
                <s.icon className="size-5" />
              </span>
              <span className="font-mono text-sm text-slate-300">0{i + 1}</span>
            </div>
            <h3 className="mt-5 text-lg font-bold tracking-tight">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const PRINCIPLES = [
  {
    icon: BadgeCheck,
    title: "Evidence, not guesses",
    body: "Each match shows the quotes behind it and flags anything that's a paraphrase or an inference.",
  },
  {
    icon: Gauge,
    title: "Scoring you can read",
    body: "Give value, how long it's been since you spoke, timing, relationship strength and confidence. Every point is shown.",
  },
  {
    icon: Handshake,
    title: "Consent before connection",
    body: "You ask each person first, then make the intro. Daily Networker drafts each message along the way.",
  },
  {
    icon: ListChecks,
    title: "Never pads the list",
    body: "If nothing is worth an intro today, you'll see an empty briefing, not filler.",
  },
];

function Principles() {
  return (
    <section className="relative overflow-hidden bg-[#f8f9fc] py-24">
      <div aria-hidden className="absolute -right-40 top-0 size-[520px] rounded-full bg-indigo-100/70 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow="Built for trust"
            title="Introductions your network will thank you for"
            align="left"
          />
          <dl className="mt-10 grid gap-6 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div key={p.title}>
                <dt className="flex items-center gap-2 font-semibold text-slate-900">
                  <p.icon className="size-4 text-ink-600" /> {p.title}
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-slate-500">{p.body}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ScorePreview />
      </div>
    </section>
  );
}

function ScorePreview() {
  const rows = [
    ["Give value", 45, "bg-ink-600"],
    ["Connection cooling", 18.9, "bg-violet-400"],
    ["Timeliness", 11.6, "bg-sky-400"],
    ["Match confidence", 9, "bg-indigo-300"],
    ["Relationship strength", 7, "bg-slate-300"],
  ] as const;
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-card-lg">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-800">Priority score</span>
        <span className="text-2xl font-bold tracking-tight">
          91.5 <span className="text-sm font-medium text-slate-400">/ 100</span>
        </span>
      </div>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
        {rows.map(([label, v, color]) => (
          <div key={label} className={`${color} border-r-2 border-white last:border-0`} style={{ width: `${v}%` }} />
        ))}
      </div>
      <ul className="mt-5 space-y-2.5 text-sm">
        {rows.map(([label, v, color]) => (
          <li key={label} className="flex items-center gap-3">
            <span className={`size-2.5 rounded-full ${color}`} />
            <span className="flex-1 text-slate-600">{label}</span>
            <span className="font-mono text-slate-500">+{v.toFixed(1)}</span>
          </li>
        ))}
      </ul>
      <figure className="mt-6 rounded-xl border-l-[3px] border-ink-200 bg-slate-50 px-4 py-3">
        <blockquote className="text-sm leading-relaxed text-slate-700">
          &ldquo;She&apos;s looking for a production agency that understands B2B and wants to launch by January.&rdquo;
        </blockquote>
        <figcaption className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700">
          <BadgeCheck className="size-3.5" /> verbatim in note
        </figcaption>
      </figure>
    </div>
  );
}

function ClosingCta() {
  return (
    <section className="px-6 py-24">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-[#0d0b29] px-8 py-16 text-center text-white sm:px-16">
        <div aria-hidden className="absolute -left-20 -top-24 size-80 rounded-full bg-indigo-500/30 blur-3xl" />
        <div aria-hidden className="absolute -bottom-24 -right-16 size-80 rounded-full bg-orange-400/20 blur-3xl" />
        <div className="relative">
          <Logo size={36} />
          <h2 className="mx-auto mt-6 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
            Your network already has the answers. Start connecting them.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-indigo-100/70">
            Daily Networker is in an invite-only pilot. Have a code? Create your account and load a demo network in one click.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-ink-900 transition hover:bg-indigo-50"
            >
              Create account <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold transition hover:bg-white/10"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, align = "center" }: { eyebrow: string; title: string; align?: "center" | "left" }) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <p className="text-sm font-semibold uppercase tracking-wider text-ink-600">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{title}</h2>
    </div>
  );
}
