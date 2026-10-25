"use client";

import { UserPlus, X } from "lucide-react";
import { useActionState, useRef } from "react";
import { createContactAction, type CreateContactState } from "@/app/actions";
import { SubmitButton } from "./submit-button";
import { btn, input } from "./ui";

export function AddContactModal({ defaultDate, compact = false }: { defaultDate: string; compact?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState<CreateContactState, FormData>(createContactAction, { error: null });

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className={`inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition active:scale-[0.98] ${btn.primary} ${
          compact ? "size-9" : "w-full px-3.5 py-2.5"
        }`}
        title="Add contact"
      >
        <UserPlus className="size-4" />
        {!compact && "Add contact"}
      </button>
      <dialog
        ref={dialog}
        className="m-auto w-full max-w-lg rounded-2xl border border-slate-200 p-0 shadow-card-lg backdrop:bg-slate-950/30 backdrop:backdrop-blur-sm"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      >
        <form action={action} className="space-y-3 p-7">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-slate-950">Add a contact</h2>
              <p className="text-sm text-slate-500">Claude extracts needs and offers from your notes.</p>
            </div>
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <X className="size-5" />
            </button>
          </div>

          <input name="name" required placeholder="Full name *" className={input} autoFocus />
          <div className="grid grid-cols-2 gap-2">
            <input name="title" placeholder="Title" className={input} />
            <input name="company" placeholder="Company" className={input} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input name="industry" placeholder="Industry" className={input} />
            <select name="relationship_strength" defaultValue="3" className={input} aria-label="Relationship strength">
              <option value="1">Relationship: 1 · just met</option>
              <option value="2">Relationship: 2 · acquaintance</option>
              <option value="3">Relationship: 3 · know well</option>
              <option value="4">Relationship: 4 · trusted</option>
              <option value="5">Relationship: 5 · close</option>
            </select>
          </div>
          <input name="introduction_preferences" placeholder="Intro preferences (e.g. no investor intros)" className={input} />

          <div className="space-y-2 rounded-xl bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
            <div className="flex items-center justify-between text-sm font-medium text-slate-700">
              <span>First conversation (optional)</span>
              <input
                type="date"
                name="last_interaction_date"
                defaultValue={defaultDate}
                className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs"
              />
            </div>
            <textarea
              name="notes"
              rows={4}
              placeholder="What did you learn? What are they looking for, and what could they offer others?"
              className={input}
            />
          </div>

          <label className="flex items-start gap-2 text-xs leading-relaxed text-slate-500">
            <input type="checkbox" name="consent" required className="mt-0.5 accent-ink-600" />
            This person is OK being in Daily Networker. Their name, title and company will be searched on the public web.
          </label>

          {state.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => dialog.current?.close()} className={`rounded-lg px-3.5 py-2 text-sm font-medium ${btn.ghost}`}>
              Cancel
            </button>
            <SubmitButton pendingText="Saving & extracting…" className={btn.primary}>
              Add contact
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
