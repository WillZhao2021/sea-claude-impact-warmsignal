import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import Link from "next/link";
import { CircleUser, Coffee, House, ListChecks, LogOut, MessageCircle, Users } from "lucide-react";
import { signOutAction } from "@/app/actions";
import { AddContactModal } from "@/components/add-contact-modal";
import { NavLink } from "@/components/nav-link";
import { Logo } from "@/components/ui";
import { currentUserEmail } from "@/lib/auth";
import { defaultEvalDate } from "@/lib/briefing";
import "./globals.css";

const sans = Plus_Jakarta_Sans({ variable: "--font-sans-face", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Daily Networker",
  description: "Be the person who always has something valuable to give.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const email = await currentUserEmail();
  return (
    <html lang="en" className={`${sans.variable} h-full antialiased`}>
      <body className="min-h-full font-sans text-slate-900">
        {email ? <AppShell email={email}>{children}</AppShell> : <main className="min-h-screen">{children}</main>}
      </body>
    </html>
  );
}

function AppShell({ email, children }: { email: string; children: React.ReactNode }) {
  const nav = (
    <>
      <NavLink href="/">
        <House className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Today</span>
      </NavLink>
      <NavLink href="/chat">
        <MessageCircle className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Chat</span>
      </NavLink>
      <NavLink href="/onboarding">
        <ListChecks className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Setup</span>
      </NavLink>
      <NavLink href="/catch-up">
        <Coffee className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Keep warm</span>
      </NavLink>
      <NavLink href="/contacts">
        <Users className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Contacts</span>
      </NavLink>
      <NavLink href="/me">
        <CircleUser className="size-5" strokeWidth={1.75} /> <span className="max-sm:sr-only">Me</span>
      </NavLink>
    </>
  );
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 shrink-0 border-r border-slate-200/70 bg-white lg:block">
      <aside className="sticky top-0 flex h-screen flex-col px-5 py-7">
        <Link href="/" className="flex items-center gap-2.5 px-2 text-xl font-bold tracking-tight text-slate-950">
          <Logo /> Daily Networker
        </Link>
        <nav className="mt-10 space-y-1">{nav}</nav>
        <div className="mt-6 border-t border-slate-100 pt-6">
          <AddContactModal defaultDate={defaultEvalDate()} />
        </div>
        <form action={signOutAction} className="mt-auto flex items-center gap-1 rounded-xl">
          <Link
            href="/me"
            title="Your profile and settings"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-slate-50"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink-50 text-sm font-semibold text-ink-800">
              {email[0]!.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{email}</span>
          </Link>
          <button type="submit" title="Sign out" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <LogOut className="size-4" />
          </button>
        </form>
      </aside>
      </div>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200/70 bg-white/80 px-4 py-3 backdrop-blur lg:hidden">
          <Link href="/" className="mr-1 flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <Logo size={20} /> <span className="hidden sm:inline">Daily Networker</span>
          </Link>
          <nav className="flex min-w-0 gap-1 overflow-x-auto [&_a]:shrink-0 [&_a]:gap-2 [&_a]:px-2.5 [&_a]:py-1.5 [&_a]:text-sm">{nav}</nav>
          <div className="ml-auto">
            <AddContactModal defaultDate={defaultEvalDate()} compact />
          </div>
        </header>
        <div className="relative overflow-hidden">
          <Glow />
          <main className="relative mx-auto max-w-5xl px-5 py-10 sm:px-10">{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Soft indigo wave in the top-right corner, behind page content. */
function Glow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] overflow-hidden">
      <div className="absolute -right-24 -top-48 h-[420px] w-[640px] rotate-[-12deg] rounded-full bg-gradient-to-bl from-indigo-200/80 via-violet-100/60 to-transparent blur-3xl" />
      <div className="absolute -top-24 right-56 h-[260px] w-[420px] rounded-full bg-sky-100/50 blur-3xl" />
    </div>
  );
}
