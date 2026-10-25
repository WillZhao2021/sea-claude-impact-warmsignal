"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Check,
  Copy,
  FileUp,
  Globe,
  HandHeart,
  Lightbulb,
  Loader2,
  MessageCircle,
  Paperclip,
  PenLine,
  Phone,
  Sparkles,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatUploadAction } from "@/app/chat/actions";
import { appendText, MicButton } from "../dictation";
import type { ChatCard, ChatFrame, ChatRow, PersonCard } from "@/lib/chat/cards";
import { whatsappLink } from "@/lib/phonebook";
import { Avatar, btn, card as cardCls, MoveTag, SignalBars } from "../ui";

type Live = { text: string; cards: ChatCard[]; tool: string | null };

/** Chat-tab suggestions, always above the message box: ways to fill in the network. */
const SUGGESTIONS = [
  "What's missing in my network?",
  "Look up my closest 5 on the web",
  "Add phone numbers",
  "Upload LinkedIn connections",
  "I just met someone new",
  "Who should I talk to today?",
];

type Mode = "onboarding" | "main";

export function Chat({
  mode,
  initial,
  redo = false,
  autoOpen = true,
  header,
}: {
  mode: Mode;
  initial: ChatRow[];
  redo?: boolean;
  /** Let the assistant speak first on load (the server still skips it if the thread is fresh). */
  autoOpen?: boolean;
  /** Shown above the conversation (the Setup checklist). */
  header?: React.ReactNode;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<ChatRow[]>(initial);
  const [live, setLive] = useState<Live | null>(null);
  const [input, setInput] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const busy = live != null || uploading;

  // Braces, not an expression body: newer browsers return a Promise from smooth scrollIntoView,
  // and React would treat a returned value as this effect's cleanup and call it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [rows, live]);

  /** Sends a message, or with `open` asks the assistant to start a round itself (no user bubble). */
  const send = useCallback(
    async (text: string, open = false) => {
      const message = text.trim();
      if ((!message && !open) || live) return;
      setError(null);
      if (!open) {
        setInput("");
        setRows((r) => [...r, { id: `u${Date.now()}`, role: "user", text: message, cards: [] }]);
      }
      const acc: Live = { text: "", cards: [], tool: null };
      setLive({ ...acc });
      const finish = () => {
        setRows((r) => (acc.text || acc.cards.length ? [...r, { id: `a${Date.now()}`, role: "assistant", text: acc.text, cards: acc.cards }] : r));
        setLive(null);
        // Setup's checklist is server-rendered from saved data: refresh it after each turn.
        if (mode === "onboarding") router.refresh();
      };
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(open ? { mode, open: true } : { mode, message }),
        });
        if (open && res.ok && res.headers.get("content-type")?.includes("application/json")) {
          setLive(null); // the thread is active; nothing to open
          return;
        }
        if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream")) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const f = JSON.parse(data) as ChatFrame;
            if (f.type === "text") {
              acc.text += f.delta;
              acc.tool = null;
            } else if (f.type === "tool") acc.tool = f.label;
            else if (f.type === "card") acc.cards = [...acc.cards, f.card];
            else if (f.type === "error") setError(f.message);
            setLive({ ...acc });
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Connection lost");
      }
      finish();
    },
    [live, mode, router],
  );

  // On load the assistant speaks first: onboarding greets new users; the main chat asks about
  // people with missing information (the server skips this if the conversation is still fresh).
  useEffect(() => {
    if (started.current || !autoOpen) return;
    started.current = true;
    void send("", true);
  }, [send, autoOpen]);

  async function upload(file: File | undefined) {
    if (!file || busy) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    const r = await chatUploadAction(form).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (r.ok) void send(r.summary);
    else setError(r.error);
  }

  const act = { send, upload, busy };

  return (
    <div className="mx-auto flex h-[calc(100dvh-9rem)] max-w-3xl flex-col lg:h-[calc(100dvh-6rem)]">
      {header}
      <div className="flex-1 space-y-5 overflow-y-auto pb-6 pr-1">
        {rows.length === 0 && !live && (
          <div className="pt-16 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-ink-50 text-ink-600">
              <Sparkles className="size-6" />
            </div>
            <h2 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
              {mode === "onboarding" ? (redo ? "Let's update your setup" : "Let's set you up") : "What's happening in your network?"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {mode === "onboarding"
                ? redo
                  ? "Tell me what you'd like to change."
                  : "A few quick questions, then your contacts. Takes about five minutes."
                : "Tell me what you know about people, or pick a suggestion below."}
            </p>
          </div>
        )}
        {rows.map((r) => (
          <Row key={r.id} row={r} act={act} />
        ))}
        {live && (
          <Row
            row={{ id: "live", role: "assistant", text: live.text, cards: live.cards }}
            act={act}
            status={live.tool ?? (live.text ? null : "Thinking")}
          />
        )}
        {uploading && <Status label="Importing your file" />}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div ref={endRef} />
      </div>

      {mode === "main" && !busy && (
        <div className="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${btn.secondary}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className={`${cardCls} flex items-end gap-2 p-2`}
      >
        <input ref={fileRef} type="file" accept=".csv,.vcf,text/csv,text/vcard" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
        <button
          type="button"
          title="Upload LinkedIn connections or an address book"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex size-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40"
        >
          <Paperclip className="size-5" />
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={1}
          placeholder={interim ? `${interim}…` : "Message Daily Networker… (or tap the mic)"}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-slate-400"
        />
        <MicButton disabled={busy} onFinal={(p) => setInput((v) => appendText(v, p))} onInterim={setInterim} />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${btn.primary} disabled:opacity-40`}
          title="Send"
        >
          <ArrowUp className="size-5" />
        </button>
      </form>
    </div>
  );
}

type Act = { send: (t: string) => void; upload: (f: File | undefined) => void; busy: boolean };

function Row({ row, act, status }: { row: ChatRow; act: Act; status?: string | null }) {
  if (row.role === "user") {
    const isUpload = row.text.startsWith("[Upload]");
    return (
      <div className="flex justify-end">
        <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-sm ${isUpload ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200" : "bg-ink-600 text-white"}`}>
          {isUpload && <FileUp className="mr-1.5 inline size-4 align-[-3px]" />}
          {isUpload ? row.text.replace(/^\[Upload\]\s*/, "") : row.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-50 text-ink-600">
        <Sparkles className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {row.cards.map((c, i) => (
          <CardView key={i} card={c} act={act} />
        ))}
        {row.text && <RichText text={row.text} />}
        {status && <Status label={status} />}
      </div>
    </div>
  );
}

function Status({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs font-medium text-slate-400">
      <Loader2 className="size-3.5 animate-spin" /> {label}…
    </p>
  );
}

function CardView({ card, act }: { card: ChatCard; act: Act }) {
  switch (card.type) {
    case "people":
      return (
        <div className={`${cardCls} divide-y divide-slate-100 overflow-hidden`}>
          <div className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Users className="size-3.5" /> {card.title}
          </div>
          {card.people.map((p) => (
            <PersonRow key={p.id} p={p} act={act} />
          ))}
        </div>
      );
    case "contact":
      return (
        <div className={`${cardCls} space-y-3 p-4`}>
          <PersonHeader p={card.person} />
          {card.summary && (
            <p className="flex gap-2 text-sm text-slate-700">
              <Globe className="mt-0.5 size-4 shrink-0 text-sky-500" /> {card.summary}
            </p>
          )}
          <SignalList icon={<Lightbulb className="size-4 text-violet-500" />} label="Needs" items={card.needs} />
          <SignalList icon={<HandHeart className="size-4 text-emerald-600" />} label="Can offer" items={card.offers} />
          <div className="flex flex-wrap gap-2">
            <ActionButton onClick={() => act.send(`Draft a message to ${card.person.name} (contact ${card.person.id})`)} disabled={act.busy}>
              <PenLine className="size-3.5" /> Draft message
            </ActionButton>
            {!card.summary && (
              <ActionButton onClick={() => act.send(`Search the web for ${card.person.name} (contact ${card.person.id})`)} disabled={act.busy}>
                <Globe className="size-3.5" /> {card.enrichedAt ? "Search again" : "Search the web"}
              </ActionButton>
            )}
            <Link href={`/contacts/${card.person.id}`} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${btn.secondary}`}>
              Open profile
            </Link>
          </div>
        </div>
      );
    case "draft":
      return <DraftCard card={card} />;
    case "upload":
      return <UploadCard kind={card.kind} act={act} />;
    case "profile":
      return (
        <div className={`${cardCls} p-4`}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Your profile</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {card.lines.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-slate-500">{k}</dt>
                <dd className="text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "note":
      return (
        <div className={`${cardCls} space-y-2 p-4 text-sm`}>
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <Check className="size-4 text-emerald-600" /> Note saved for {card.name}
          </div>
          <SignalList icon={<Lightbulb className="size-4 text-violet-500" />} label="Needs" items={card.needs} />
          <SignalList icon={<HandHeart className="size-4 text-emerald-600" />} label="Can offer" items={card.offers} />
        </div>
      );
    case "choices":
      return <Choices options={card.options} multi={card.multi} act={act} />;
    case "notice":
      return (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200">
          <Check className="size-4" /> {card.text}
          {card.href && (
            <Link href={card.href} className="ml-auto font-semibold hover:underline">
              Open
            </Link>
          )}
        </div>
      );
  }
}

function PersonHeader({ p }: { p: PersonCard }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar name={p.name} size="md" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-slate-900">{p.name}</div>
        {p.role && <div className="truncate text-xs text-slate-500">{p.role}</div>}
        {p.move && (
          <div className="mt-1 flex">
            <MoveTag move={p.move} withWhy />
          </div>
        )}
      </div>
      <SignalBars value={p.strength} small />
    </div>
  );
}

function PersonRow({ p, act }: { p: PersonCard; act: Act }) {
  return (
    <div className="space-y-2 px-4 py-3">
      <PersonHeader p={p} />
      {p.reasons.length > 0 && (
        <ul className="space-y-0.5 pl-12 text-xs text-slate-600">
          {p.reasons.slice(0, 3).map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 pl-12">
        <ActionButton onClick={() => act.send(`Draft a message to ${p.name} (contact ${p.id})`)} disabled={act.busy}>
          <PenLine className="size-3.5" /> Draft
        </ActionButton>
        <ActionButton onClick={() => act.send(`Tell me about ${p.name} (contact ${p.id})`)} disabled={act.busy}>
          More
        </ActionButton>
        {p.phone && (
          <a href={whatsappLink(p.phone)} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${btn.secondary}`}>
            <MessageCircle className="size-3.5 text-emerald-600" /> WhatsApp
          </a>
        )}
      </div>
    </div>
  );
}

function DraftCard({ card }: { card: Extract<ChatCard, { type: "draft" }> }) {
  const [text, setText] = useState(card.text);
  const [copied, setCopied] = useState(false);
  return (
    <div className={`${cardCls} space-y-3 p-4`}>
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Draft to {card.name}</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="w-full resize-y rounded-lg bg-slate-50 p-3 text-sm text-slate-800 outline-none ring-1 ring-slate-200 focus:ring-ink-300" />
      <div className="flex flex-wrap gap-2">
        <a href={whatsappLink(card.phone, text)} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${btn.primary}`}>
          <MessageCircle className="size-3.5" /> {card.phone ? "Send on WhatsApp" : "Open WhatsApp"}
        </a>
        <ActionButton
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
        </ActionButton>
      </div>
      {!card.phone && <p className="text-xs text-slate-400">No number saved for {card.name}: WhatsApp will ask who to send it to.</p>}
    </div>
  );
}

function UploadCard({ kind, act }: { kind: "linkedin" | "phone"; act: Act }) {
  const ref = useRef<HTMLInputElement>(null);
  const linkedin = kind === "linkedin";
  return (
    <div className={`${cardCls} space-y-3 p-4 text-sm`}>
      <div className="flex items-center gap-2 font-semibold text-slate-800">
        {linkedin ? <Users className="size-4 text-ink-600" /> : <Phone className="size-4 text-emerald-600" />}
        {linkedin ? "Upload your LinkedIn connections" : "Add phone numbers for WhatsApp"}
      </div>
      {linkedin ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-slate-600">
          <li>
            <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noreferrer" className="font-medium text-ink-700 hover:underline">
              LinkedIn → Get a copy of your data
            </a>{" "}
            → choose <b>Connections</b> → Request archive.
          </li>
          <li>LinkedIn emails you a download in about 10 minutes. Unzip it and upload <b>Connections.csv</b> here.</li>
        </ol>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
          <li>
            iPhone: <b>iCloud.com → Contacts</b> → select all → <b>Export vCard</b>.
          </li>
          <li>
            Google: <b>contacts.google.com → Export → Google CSV</b>.
          </li>
          <li>Only people already in your network get numbers. Nothing is shared or sent.</li>
        </ul>
      )}
      <input
        ref={ref}
        type="file"
        accept={linkedin ? ".csv,text/csv" : ".vcf,.csv,text/vcard,text/csv"}
        className="hidden"
        onChange={(e) => act.upload(e.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={act.busy} onClick={() => ref.current?.click()} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${btn.primary} disabled:opacity-40`}>
          <FileUp className="size-3.5" /> Choose file
        </button>
        <ActionButton disabled={act.busy} onClick={() => act.send(linkedin ? "Skip the LinkedIn upload for now" : "Skip phone numbers for now")}>
          Skip for now
        </ActionButton>
      </div>
    </div>
  );
}

function SignalList({ icon, label, items }: { icon: React.ReactNode; label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="text-sm">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <ul className="mt-1 space-y-1">
        {items.map((t) => (
          <li key={t} className="flex gap-2 text-slate-700">
            <span className="mt-0.5 shrink-0">{icon}</span> {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${btn.secondary} disabled:opacity-40`}>
      {children}
    </button>
  );
}

function Choices({ options, multi, act }: { options: string[]; multi: boolean; act: Act }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const choose = (o: string) => {
    if (sent || act.busy) return;
    if (!multi) {
      setSent(true);
      setPicked([o]);
      act.send(o);
    } else setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]));
  };
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => choose(o)}
          disabled={sent || act.busy}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition ${
            picked.includes(o) ? "bg-ink-600 text-white ring-ink-600" : "bg-white text-slate-700 ring-slate-200 hover:ring-ink-300"
          } disabled:cursor-default ${sent && !picked.includes(o) ? "opacity-40" : ""}`}
        >
          {o}
        </button>
      ))}
      {multi && !sent && (
        <button
          type="button"
          disabled={!picked.length || act.busy}
          onClick={() => {
            setSent(true);
            act.send(picked.join(", "));
          }}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${btn.primary} disabled:opacity-40`}
        >
          Done
        </button>
      )}
    </div>
  );
}

/** Plain text with light formatting: "- " bullets and **bold**, in case the model uses them. */
function RichText({ text }: { text: string }) {
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : part,
    );
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length} className="list-disc space-y-0.5 pl-5">{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*[-*•]\s+(.*)$/);
    if (m) bullets.push(m[1]);
    else {
      flush();
      if (raw.trim()) blocks.push(<p key={blocks.length}>{inline(raw.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  return <div className="space-y-2 text-sm leading-relaxed text-slate-800">{blocks}</div>;
}
