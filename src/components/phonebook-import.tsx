"use client";

import { Phone } from "lucide-react";
import { useActionState } from "react";
import { importPhonebookAction, type PhonebookState } from "@/app/actions";
import { SubmitButton } from "./submit-button";
import { btn, card } from "./ui";

/** Upload an address book to add phone numbers (for WhatsApp) and emails to existing contacts. */
export function PhonebookImport() {
  const [state, action] = useActionState<PhonebookState, FormData>(importPhonebookAction, { status: "idle" });
  return (
    <form action={action} className={`${card} flex flex-wrap items-center gap-3 px-5 py-4 text-sm`}>
      <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
        <Phone className="size-4" />
      </span>
      <div className="min-w-[14rem] flex-1">
        <div className="font-semibold text-slate-800">Add phone numbers</div>
        <div className="text-xs text-slate-500">
          vCard (.vcf) from iPhone/iCloud or Mac Contacts, or a Google Contacts CSV. Only fills in people already in your
          network; numbers stay private and are used only for your WhatsApp links.
        </div>
        {state.status === "error" && <div className="mt-1 text-xs text-rose-600">{state.error}</div>}
        {state.status === "done" && (
          <div className="mt-1 text-xs text-emerald-700">
            Added details to {state.updated} {state.updated === 1 ? "contact" : "contacts"} from {state.entries} address-book
            entries.
            {state.ambiguous.length > 0 && (
              <span className="text-amber-700"> Skipped (more than one match): {state.ambiguous.join(", ")}.</span>
            )}
          </div>
        )}
      </div>
      <input
        type="file"
        name="file"
        accept=".vcf,.csv,text/vcard,text/csv"
        className="max-w-56 text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
      />
      <SubmitButton pendingText="Matching…" className={btn.secondary}>
        Add numbers
      </SubmitButton>
    </form>
  );
}
