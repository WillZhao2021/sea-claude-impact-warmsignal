"use client";

import { CircleAlert, CircleCheck, Info, Upload } from "lucide-react";
import { useActionState } from "react";
import { importCsvAction, type ImportState } from "@/app/actions";
import { LINKEDIN_EXPORT_URL, LINKEDIN_MAX } from "@/lib/linkedin";
import { SubmitButton } from "./submit-button";
import { btn, card } from "./ui";

/** The Contacts page import card. Shows the result (or what was wrong with the file) inline. */
export function ImportCsvForm() {
  const [state, action] = useActionState<ImportState, FormData>(importCsvAction, { error: null });
  return (
    <form action={action} className={`${card} px-5 py-4 text-sm`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-ink-50 text-ink-600">
          <Upload className="size-4" />
        </span>
        <div className="min-w-[14rem] flex-1">
          <div className="font-semibold text-slate-800">Import from CSV or LinkedIn</div>
          <div className="group relative text-xs text-slate-500">
            Upload any CSV with a name column, or LinkedIn&apos;s{" "}
            <a href={LINKEDIN_EXPORT_URL} target="_blank" rel="noreferrer" className="font-medium text-ink-700 hover:underline">
              Connections export
            </a>{" "}
            as is. New contacts are enriched from the public web.
            <Info className="ml-1 inline size-3.5 align-[-3px] text-slate-400" />
            <span className="pointer-events-none absolute left-0 top-full z-10 mt-2 hidden w-80 rounded-lg bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg group-hover:block">
              Columns like name, company, title, industry and relationship are recognized automatically. Daily Networker&apos;s
              own format (contact_id, name, company, title, industry, relationship_strength 1–5, last_interaction_date
              YYYY-MM-DD, introduction_preferences) updates by contact_id. LinkedIn exports, including ones from
              scraping tools: up to {LINKEDIN_MAX} connections are added as new contacts. Existing contacts are never
              overwritten, except by contact_id. Only name, title and company are searched (Tavily).
            </span>
          </div>
        </div>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          className="max-w-56 text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />
        <SubmitButton pendingText="Importing…" className={btn.primary}>
          Import
        </SubmitButton>
      </div>
      {state.error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-700">
          <CircleAlert className="mt-0.5 size-4 shrink-0" /> {state.error}
        </p>
      )}
      {state.message && (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">
          <CircleCheck className="mt-0.5 size-4 shrink-0" /> {state.message}
        </p>
      )}
    </form>
  );
}
