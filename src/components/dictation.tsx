"use client";

import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Voice dictation with the browser's built-in speech recognition (Web Speech API): no server,
// no keys, and no audio is stored; only the text lands in the box for the user to review.
// Hidden where unsupported (e.g. Firefox); phone keyboards' mic still works there.

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noSubscribe = () => () => {};

/**
 * Mic toggle. `onFinal` receives each finished phrase (append it to your text); `onInterim` the
 * words still being recognized (show them, don't save them).
 */
export function MicButton({
  onFinal,
  onInterim,
  disabled,
  className = "",
}: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  // Server render says "unsupported", the client checks the browser: no hydration mismatch.
  const supported = useSyncExternalStore(noSubscribe, () => !!recognitionClass(), () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  // Latest callbacks without restarting recognition.
  const cb = useRef({ onFinal, onInterim });
  useEffect(() => {
    cb.current = { onFinal, onInterim };
  }, [onFinal, onInterim]);
  useEffect(() => () => rec.current?.stop(), []);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionClass();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current.onFinal(res[0].transcript.trim());
        else interim += res[0].transcript;
      }
      cb.current.onInterim?.(interim.trim());
    };
    r.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone blocked: allow it in the browser's site settings." : null);
    r.onend = () => {
      setListening(false);
      cb.current.onInterim?.("");
    };
    rec.current = r;
    setError(null);
    r.start();
    setListening(true);
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={listening ? "Stop dictation" : "Dictate (speak instead of typing)"}
        aria-label={listening ? "Stop dictation" : "Dictate"}
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-40 ${
          listening ? "animate-pulse bg-rose-50 text-rose-600 ring-1 ring-rose-200" : "text-slate-500 hover:bg-slate-100"
        } ${className}`}
      >
        {listening ? <Square className="size-4 fill-current" /> : <Mic className="size-5" />}
      </button>
      {error && <span className="absolute bottom-full right-0 mb-1 w-56 rounded-lg bg-slate-900 px-2 py-1 text-xs text-white">{error}</span>}
    </span>
  );
}

/** Joins dictated phrases onto existing text with a single space. */
export const appendText = (text: string, phrase: string) => (phrase ? (text.trim() ? `${text.trimEnd()} ${phrase}` : phrase) : text);

/** A form textarea with a mic: dictated words are appended, and shown live while you speak. */
export function DictationTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { name: string }) {
  const [value, setValue] = useState(String(props.defaultValue ?? ""));
  const [interim, setInterim] = useState("");
  const { className, ...rest } = props;
  return (
    <div className="relative">
      <textarea {...rest} defaultValue={undefined} value={value} onChange={(e) => setValue(e.target.value)} className={`${className} pr-12`} />
      {interim && <p className="mt-1 text-xs italic text-slate-400">{interim}…</p>}
      <div className="absolute right-1.5 top-1.5">
        <MicButton onFinal={(p) => setValue((v) => appendText(v, p))} onInterim={setInterim} />
      </div>
    </div>
  );
}
