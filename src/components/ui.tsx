import { Gift, HandHelping } from "lucide-react";

/** Shared visual primitives. No client state, so usable from server and client components. */

export const btn = {
  primary: "bg-ink-900 text-white shadow-sm hover:bg-ink-800",
  secondary: "border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50",
  ghost: "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
  success: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700",
};

export const input =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-ink-500 focus:ring-4 focus:ring-ink-100";

export const card = "rounded-2xl border border-slate-200/80 bg-white shadow-card";

export function Logo({ size = 28 }: { size?: number }) {
  // Plain elements rather than SVG gradients: SVG gradient ids collide when the logo renders twice.
  return (
    <span aria-hidden className="relative inline-block shrink-0" style={{ width: size * 1.4, height: size }}>
      <span className="absolute left-0 top-0 rounded-full bg-gradient-to-br from-indigo-200 to-indigo-300" style={{ width: size * 0.84, height: size * 0.84, top: size * 0.08 }} />
      <span className="absolute right-0 rounded-full bg-gradient-to-br from-indigo-400 to-ink-600 opacity-95" style={{ width: size * 0.84, height: size * 0.84, top: size * 0.08 }} />
    </span>
  );
}

const PALETTES = [
  "from-indigo-400 to-violet-500",
  "from-sky-400 to-indigo-500",
  "from-violet-400 to-fuchsia-500",
  "from-blue-400 to-cyan-500",
  "from-purple-400 to-indigo-600",
  "from-teal-400 to-sky-500",
];

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const hash = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const sizes = {
    sm: "size-8 text-xs",
    md: "size-10 text-sm",
    lg: "size-16 text-xl",
    xl: "size-20 text-2xl",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ring-4 ring-white shadow-sm ${PALETTES[hash % PALETTES.length]} ${sizes[size]}`}
    >
      {initials}
    </span>
  );
}

const TONES = {
  violet: "bg-violet-50 text-violet-900 ring-violet-200/70",
  sky: "bg-sky-50 text-sky-900 ring-sky-200/70",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200/70",
  emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200/70",
};

export function Chip({
  children,
  tone = "slate",
  className = "",
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Relationship strength 1–5 as phone-style signal bars. */
export function SignalBars({ value, max = 5, small = false }: { value: number; max?: number; small?: boolean }) {
  return (
    <span className="inline-flex items-end gap-[3px]" title={`Relationship ${value}/${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`rounded-full ${small ? "w-[3px]" : "w-[4px]"} ${i < value ? "bg-ink-500" : "bg-slate-200"}`}
          style={{ height: small ? 3 + i * 2 : 5 + i * 3 }}
        />
      ))}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="relative flex flex-wrap items-end justify-between gap-6">
      <div className="min-w-0">
        {eyebrow && <p className="text-sm font-medium text-slate-500">{eyebrow}</p>}
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-base text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Give / Ask: the next move with a contact (src/lib/moves.ts). The reason shows on hover, or inline with `withWhy`. */
export function MoveTag({ move, withWhy = false }: { move: { kind: "give" | "ask"; why: string }; withWhy?: boolean }) {
  const give = move.kind === "give";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={withWhy ? undefined : move.why}>
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
          give ? "bg-violet-50 text-violet-700 ring-violet-200/70" : "bg-teal-50 text-teal-700 ring-teal-200/70"
        }`}
      >
        {give ? <Gift className="size-3" /> : <HandHelping className="size-3" />}
        {give ? "Give" : "Ask"}
      </span>
      {withWhy && <span className="truncate text-xs text-slate-500">{move.why}</span>}
    </span>
  );
}
