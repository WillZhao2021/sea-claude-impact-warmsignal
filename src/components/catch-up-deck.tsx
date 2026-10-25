"use client";

import Link from "next/link";
import {
  ArrowUp,
  Check,
  Clock,
  Coffee,
  HandHeart,
  Lightbulb,
  MessageCircle,
  Newspaper,
  PartyPopper,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { catchUpDecisionAction, catchUpDraftAction, type Result } from "@/app/actions";
import type { CatchUpCard, CatchUpDecision, ReasonKind } from "@/lib/catch-up";
import { DraftBox } from "./draft-box";
import { Avatar, btn, card as cardCls, SignalBars } from "./ui";

/** Drag distance (px) past which a release counts as a swipe. */
const THRESHOLD = 110;
const EXIT_MS = 240;

type Exit = "left" | "right" | "up" | null;

const REASON_ICONS: Record<ReasonKind, React.ReactNode> = {
  give: <HandHeart className="size-4 text-emerald-600" />,
  need: <Lightbulb className="size-4 text-violet-500" />,
  news: <Newspaper className="size-4 text-sky-500" />,
  last_time: <MessageCircle className="size-4 text-slate-400" />,
};

const first = (name: string) => name.split(" ")[0];

export function CatchUpDeck({ cards, evalDate, snoozeDays }: { cards: CatchUpCard[]; evalDate: string; snoozeDays: number }) {
  const [queue, setQueue] = useState(cards);
  const [decided, setDecided] = useState<{ card: CatchUpCard; decision: CatchUpDecision }[]>([]);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [exit, setExit] = useState<Exit>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Result<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const start = useRef<{ x: number; y: number } | null>(null);
  const requested = useRef(new Set<string>());

  const top = queue[0];

  const loadDraft = useCallback(
    (id: string, fresh = false) => {
      requested.current.add(id);
      if (fresh) {
        setDrafts((d) => {
          const next = { ...d };
          delete next[id]; // back to the loading state
          return next;
        });
      }
      catchUpDraftAction(id, evalDate, fresh).then(
        (r) => setDrafts((d) => ({ ...d, [id]: r })),
        () => setDrafts((d) => ({ ...d, [id]: { ok: false, error: "Couldn't reach the server" } })),
      );
    },
    [evalDate],
  );

  // Draft the top card's message while it's being read, so it's ready on a right swipe.
  useEffect(() => {
    if (top && !requested.current.has(top.id)) loadDraft(top.id);
  }, [top, loadDraft]);

  const reset = () => {
    setExit(null);
    setDrag({ x: 0, y: 0 });
    setSheetOpen(false);
  };

  const commit = useCallback(
    (decision: CatchUpDecision) => {
      if (!top) return;
      setQueue((q) => q.slice(1));
      setDecided((d) => [...d, { card: top, decision }]);
      reset();
      setError(null);
      // Optimistic: put the card back if saving fails.
      startTransition(async () => {
        const r = await catchUpDecisionAction(top.id, decision, evalDate).catch(() => null);
        if (r?.ok) return;
        setError(`Couldn't save your choice for ${top.name}${r ? `: ${r.error}` : ""}. Try again.`);
        setQueue((q) => [top, ...q]);
        setDecided((d) => d.filter((x) => x.card.id !== top.id));
      });
    },
    [top, evalDate],
  );

  const swipe = useCallback(
    (dir: Exclude<Exit, null>) => {
      if (!top || exit) return;
      setExit(dir);
      setTimeout(() => {
        if (dir === "right") setSheetOpen(true);
        else if (dir === "left") commit("snooze");
        else {
          setQueue((q) => [...q.slice(1), q[0]]); // skip: move to the back, no change saved
          reset();
        }
      }, EXIT_MS);
    },
    [top, exit, commit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (sheetOpen) {
        if (e.key === "Escape") reset();
        return;
      }
      if (e.key === "ArrowRight") swipe("right");
      else if (e.key === "ArrowLeft") swipe("left");
      else if (e.key === "ArrowUp") swipe("up");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen, swipe]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (exit || e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (drag.x > THRESHOLD) swipe("right");
    else if (drag.x < -THRESHOLD) swipe("left");
    else setDrag({ x: 0, y: 0 });
  };

  const total = cards.length;
  const done = decided.length;

  if (!top) return <DeckDone decided={decided} total={total} snoozeDays={snoozeDays} />;

  const topTransform =
    exit === "right"
      ? "translate(140%, 0) rotate(18deg)"
      : exit === "left"
        ? "translate(-140%, 0) rotate(-18deg)"
        : exit === "up"
          ? "translate(0, -120%)"
          : `translate(${drag.x}px, ${drag.y * 0.25}px) rotate(${drag.x / 18}deg)`;
  const meet = Math.min(1, Math.max(0, drag.x / THRESHOLD));
  const later = Math.min(1, Math.max(0, -drag.x / THRESHOLD));

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-5 flex items-center gap-3 text-xs font-medium text-slate-500">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/70">
          <div className="h-full rounded-full bg-ink-500 transition-all duration-500" style={{ width: `${(done / total) * 100}%` }} />
        </div>
        {done} of {total}
      </div>

      {error && <p className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <div className="relative h-[460px] select-none">
        {queue
          .slice(0, 3)
          .map((c, i) => (
            <div
              key={c.id}
              className={`absolute inset-0 ${i === 0 ? "cursor-grab touch-pan-y active:cursor-grabbing" : "pointer-events-none"}`}
              style={{
                zIndex: 3 - i,
                transform: i === 0 ? topTransform : `translateY(${i * 14}px) scale(${1 - i * 0.045})`,
                opacity: i === 0 ? (exit ? 0 : 1) : 1 - i * 0.25,
                transition: i === 0 && dragging ? "none" : `transform ${EXIT_MS + 80}ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity ${EXIT_MS + 80}ms`,
              }}
              {...(i === 0 && { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp })}
            >
              <PersonCard c={c} meet={i === 0 ? meet : 0} later={i === 0 ? later : 0} />
            </div>
          ))
          .reverse()}
      </div>

      <div className="mt-6 flex items-center justify-center gap-5">
        <RoundButton label={`Not now (${snoozeDays}d)`} onClick={() => swipe("left")} className="size-14 text-slate-500 hover:text-rose-500">
          <X className="size-6" strokeWidth={2.5} />
        </RoundButton>
        <RoundButton label="Skip for now" onClick={() => swipe("up")} className="size-11 text-slate-400 hover:text-slate-700">
          <ArrowUp className="size-5" />
        </RoundButton>
        <RoundButton label="Suggest meeting up" onClick={() => swipe("right")} className="size-16 !bg-ink-900 text-white hover:!bg-ink-800">
          <Coffee className="size-7" />
        </RoundButton>
      </div>
      <p className="mt-4 text-center text-xs text-slate-400">
        Swipe right to meet up, left for not now · or use ← ↑ → keys
      </p>

      {sheetOpen && (
        <SendSheet
          c={top}
          draft={drafts[top.id]}
          onRedraft={() => loadDraft(top.id, true)}
          onSent={() => commit("sent")}
          onBack={reset}
        />
      )}
    </div>
  );
}

function PersonCard({ c, meet, later }: { c: CatchUpCard; meet: number; later: number }) {
  const role = [c.title, c.company].filter(Boolean).join(", ");
  return (
    <article className={`${cardCls} relative flex h-full flex-col overflow-hidden !shadow-card-lg`}>
      <Stamp opacity={meet} className="left-5 rotate-[-10deg] text-emerald-600 ring-emerald-500">
        Meet up
      </Stamp>
      <Stamp opacity={later} className="right-5 rotate-[10deg] text-slate-500 ring-slate-400">
        Not now
      </Stamp>

      <div className="flex flex-col items-center bg-gradient-to-b from-indigo-50 via-violet-50/40 to-white px-6 pb-5 pt-8 text-center">
        <Avatar name={c.name} size="xl" />
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">{c.name}</h2>
        {role && <p className="text-sm text-slate-500">{role}</p>}
        <div className="mt-3 flex items-center gap-3 text-xs font-medium text-slate-600">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 shadow-sm ring-1 ring-slate-200/70">
            <Clock className="size-3.5 text-ink-500" />
            {c.daysSinceMet == null ? "No conversation logged" : `Last talked ${c.daysSinceMet} days ago`}
          </span>
          <SignalBars value={c.relationshipStrength} small />
        </div>
      </div>

      <ul className="flex-1 space-y-3 overflow-hidden px-6 py-4 text-sm leading-snug text-slate-700">
        {c.reasons.length === 0 && (
          <li className="flex gap-3 text-slate-500">
            <Sparkles className="size-4 shrink-0 text-ink-400" /> It&apos;s been a while. A simple check-in keeps the connection warm.
          </li>
        )}
        {c.reasons.slice(0, 3).map((r) => (
          <li key={r.kind} className="flex gap-3">
            <span className="mt-0.5 shrink-0">{REASON_ICONS[r.kind]}</span>
            <span className="line-clamp-3">{r.text}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Stamp({ opacity, className, children }: { opacity: number; className: string; children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute top-6 z-10 rounded-lg bg-white/80 px-3 py-1 text-xl font-extrabold uppercase tracking-wider ring-[3px] ${className}`}
      style={{ opacity }}
    >
      {children}
    </span>
  );
}

function RoundButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex items-center justify-center rounded-full bg-white shadow-card-lg ring-1 ring-slate-200/70 transition hover:scale-105 active:scale-95 ${className}`}
    >
      {children}
    </button>
  );
}

function SendSheet({
  c,
  draft,
  onRedraft,
  onSent,
  onBack,
}: {
  c: CatchUpCard;
  draft: Result<string> | undefined;
  onRedraft: () => void;
  onSent: () => void;
  onBack: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/30 backdrop-blur-sm sm:items-center"
      onClick={(e) => e.target === e.currentTarget && onBack()}
    >
      <div role="dialog" aria-modal aria-label={`Message to ${c.name}`} className="w-full max-w-lg animate-rise rounded-t-2xl bg-white p-6 shadow-card-lg sm:rounded-2xl">
        <div className="flex items-center gap-3">
          <Avatar name={c.name} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold tracking-tight text-slate-950">Suggest meeting {first(c.name)}</h2>
            <p className="text-sm text-slate-500">Edit if you like, then send it from your own inbox or phone.</p>
          </div>
          <button type="button" onClick={onBack} aria-label="Back to deck" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-5">
          {!draft ? (
            <div className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-ink-600">
                <Sparkles className="size-3.5 animate-pulse" /> Claude is drafting your message…
              </div>
              {[92, 100, 70].map((w) => (
                <div key={w} className="h-2.5 animate-pulse rounded-full bg-slate-100" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : draft.ok ? (
            <DraftBox key={draft.value} draft={draft.value} label={`To ${first(c.name)}`} />
          ) : (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t draft a message: {draft.error}</p>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onSent} className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition active:scale-[0.98] ${btn.primary}`}>
            <Check className="size-4" /> I sent it
          </button>
          <button
            type="button"
            onClick={onRedraft}
            disabled={!draft}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 ${btn.ghost}`}
          >
            <RefreshCw className="size-3.5" /> Redraft
          </button>
          <button type="button" onClick={onBack} className={`ml-auto rounded-lg px-3.5 py-2 text-sm font-medium transition ${btn.secondary}`}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

function DeckDone({
  decided,
  total,
  snoozeDays,
}: {
  decided: { card: CatchUpCard; decision: CatchUpDecision }[];
  total: number;
  snoozeDays: number;
}) {
  const sent = decided.filter((d) => d.decision === "sent").map((d) => d.card);
  const snoozed = decided.length - sent.length;

  if (total === 0) {
    return (
      <div className={`${cardCls} mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center`}>
        <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
          <Check className="size-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-900">Everyone close is warm</h2>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          Nobody you know well is overdue for a catch-up, apart from the people on Today. Log your conversations on the Contacts page so Daily Networker knows who you&apos;ve seen.
        </p>
      </div>
    );
  }

  return (
    <div className={`${cardCls} mx-auto flex max-w-md animate-rise flex-col items-center px-6 py-12 text-center`}>
      <div className="flex size-14 items-center justify-center rounded-2xl bg-ink-50 text-ink-600">
        <PartyPopper className="size-6" />
      </div>
      <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-950">
        {sent.length === 0 ? "All caught up" : `You reached out to ${sent.length} ${sent.length === 1 ? "person" : "people"}`}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-slate-500">
        {sent.length > 0
          ? "When you meet, log what you learned on their contact page. It feeds tomorrow's introductions."
          : `Nobody today. They'll come back in ${snoozeDays} days.`}
        {sent.length > 0 && snoozed > 0 && ` ${snoozed} snoozed for ${snoozeDays} days.`}
      </p>
      {sent.length > 0 && (
        <ul className="mt-6 w-full divide-y divide-slate-100 rounded-xl border border-slate-100 text-left">
          {sent.map((c) => (
            <li key={c.id}>
              <Link href={`/contacts/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-slate-50">
                <Avatar name={c.name} size="sm" />
                <span className="flex-1 font-medium text-slate-800">{c.name}</span>
                <span className="text-xs text-slate-400">Log meeting →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/" className={`mt-6 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium ${btn.secondary}`}>
        Back to Today
      </Link>
    </div>
  );
}
