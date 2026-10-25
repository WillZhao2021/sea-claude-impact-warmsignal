"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthState } from "@/app/actions";
import { SubmitButton } from "./submit-button";
import { btn, card, input, Logo } from "./ui";

export function AuthForm({
  mode,
  action,
}: {
  mode: "login" | "signup";
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
}) {
  const [state, formAction] = useActionState(action, { error: null });
  const signup = mode === "signup";
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 -top-40 size-[560px] rounded-full bg-gradient-to-br from-indigo-200 via-violet-100 to-transparent opacity-70 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-48 -left-40 size-[480px] rounded-full bg-gradient-to-tr from-sky-100 via-indigo-50 to-transparent opacity-80 blur-3xl"
      />
      <div className="relative w-full max-w-sm animate-rise">
        <div className="mb-8 flex items-center justify-center gap-2.5 text-2xl font-bold tracking-tight text-slate-950">
          <Logo size={32} /> Daily Networker
        </div>
        <div className={`${card} p-8 shadow-card-lg`}>
          <h1 className="text-2xl font-bold tracking-tight text-slate-950">{signup ? "Create your account" : "Welcome back"}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {signup ? "Daily Networker is invite-only during the pilot." : "Sign in to see today's opportunities to give."}
          </p>
          <form action={formAction} className="mt-6 space-y-3">
            <input
              key={`email-${state.email}`}
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="Email"
              defaultValue={state.email}
              className={input}
            />
            <input
              name="password"
              type="password"
              required
              minLength={signup ? 8 : undefined}
              autoComplete={signup ? "new-password" : "current-password"}
              placeholder={signup ? "Password (8+ characters)" : "Password"}
              className={input}
            />
            {signup && (
              <input
                key={`invite-${state.invite}`}
                name="invite_code"
                required
                placeholder="Invite code"
                autoComplete="off"
                defaultValue={state.invite}
                className={input}
              />
            )}
            {state.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
            <SubmitButton
              pendingText={signup ? "Creating account…" : "Signing in…"}
              className={`w-full !py-2.5 ${btn.primary}`}
            >
              {signup ? "Create account" : "Sign in"}
            </SubmitButton>
          </form>
        </div>
        <p className="mt-6 text-center text-sm text-slate-500">
          {signup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-ink-700 hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              Have an invite code?{" "}
              <Link href="/signup" className="font-medium text-ink-700 hover:underline">
                Create an account
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
