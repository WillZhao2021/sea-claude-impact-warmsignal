// What chat tool calls render in the UI. Shared by the server (tools.ts) and the client (chat.tsx),
// so no server imports here. Cards can carry phone numbers for WhatsApp links; the text Claude sees
// for the same tool call never does.

export type PersonCard = {
  id: string;
  name: string;
  role: string | null;
  strength: number;
  lastSpoke: string | null;
  reasons: string[];
  phone: string | null;
  /** Give / Ask: the next move with them (src/lib/moves.ts). */
  move?: { kind: "give" | "ask"; why: string };
};

export type ChatCard =
  | { type: "people"; title: string; people: PersonCard[] }
  | {
      type: "contact";
      person: PersonCard;
      summary: string | null;
      needs: string[];
      offers: string[];
      enrichedAt: string | null;
    }
  | { type: "draft"; contactId: string; name: string; phone: string | null; text: string }
  | { type: "upload"; kind: "linkedin" | "phone" }
  | { type: "profile"; lines: [string, string][] }
  | { type: "note"; contactId: string; name: string; needs: string[]; offers: string[] }
  | { type: "notice"; text: string; href?: string }
  /** Tap-to-answer options; tapping one sends it as the user's message. */
  | { type: "choices"; options: string[]; multi: boolean };

/** Server-sent frames from /api/chat. */
export type ChatFrame =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; label: string }
  | { type: "card"; card: ChatCard }
  | { type: "done" }
  | { type: "error"; message: string };

/** One rendered chat row, built from stored messages. */
export type ChatRow = { id: string; role: "user" | "assistant"; text: string; cards: ChatCard[] };
