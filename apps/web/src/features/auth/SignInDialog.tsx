import { authStartInputSchema, authVerifyInputSchema } from "@verity/contracts";
import { Mail, X } from "lucide";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { VerityAuthApi } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useToast } from "../../components/ui/Toast";

const inputClass =
  "mt-1 h-12 w-full rounded-xl bg-surface px-3 text-base ring-1 ring-line placeholder:text-muted focus:ring-2 focus:ring-accent focus:outline-none aria-invalid:ring-red-500";

/**
 * Passwordless sign-in: email → 6-digit code. Shown only when someone tries
 * to contribute; browsing never needs an account.
 */
export function SignInDialog({
  auth,
  reason,
  onDone,
}: {
  auth: VerityAuthApi;
  reason?: string;
  onDone: (signedIn: boolean) => void;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    (step === "email" ? emailRef : codeRef).current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    const parsed = authStartInputSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a valid email address");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await auth.startEmailSignIn(parsed.data.email);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setEmail(parsed.data.email);
    setCode("");
    setStep("code");
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = authVerifyInputSchema.safeParse({ email, code });
    if (!parsed.success) {
      setError("Enter the 6-digit code from the email");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await auth.verifyEmailSignIn(parsed.data.email, parsed.data.code);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.fields?.code ?? result.error.message);
      return;
    }
    toast.show("Signed in to Verity", "success");
    onDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      {/* Backdrop: clicking outside closes, like Escape. Not focusable; the dialog has its own Close button. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-black/40"
        onClick={() => onDone(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-t-3xl bg-surface p-5 shadow-2xl ring-1 ring-line sm:rounded-3xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <Icon icon={Mail} size={20} />
          </div>
          <button type="button" onClick={() => onDone(false)} className="-m-1 rounded-lg p-2 text-muted hover:bg-surface-2" aria-label="Close">
            <Icon icon={X} size={18} />
          </button>
        </div>
        <h2 id={titleId} className="mt-3 text-lg font-semibold">
          Sign in to contribute
        </h2>

        {step === "email" ? (
          <form onSubmit={sendCode} noValidate>
            <p className="mt-1 text-sm text-muted">
              {reason ? `${reason}. ` : ""}We'll email you a 6-digit code. No password needed, and browsing never requires an account.
            </p>
            <label htmlFor={`${titleId}-email`} className="mt-4 block text-sm font-medium">
              Email address
            </label>
            <input
              ref={emailRef}
              id={`${titleId}-email`}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              maxLength={254}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${titleId}-error` : undefined}
              className={inputClass}
              placeholder="you@example.com"
            />
            {error && (
              <p id={`${titleId}-error`} role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" className="mt-4 w-full" disabled={busy}>
              {busy ? "Sending…" : "Email me a code"}
            </Button>
            <p className="mt-3 text-xs text-muted">
              Verity uses your email only to sign you in. It's separate from your Maypop profile, which Verity never uses for sign-in.
            </p>
          </form>
        ) : (
          <form onSubmit={verify} noValidate>
            <p className="mt-1 text-sm text-muted">
              Enter the code we sent to <span className="font-medium text-fg">{email}</span>. It expires in 10 minutes.
            </p>
            <label htmlFor={`${titleId}-code`} className="mt-4 block text-sm font-medium">
              6-digit code
            </label>
            <input
              ref={codeRef}
              id={`${titleId}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${titleId}-error` : undefined}
              className={`${inputClass} tracking-[0.4em]`}
              placeholder="123456"
            />
            {error && (
              <p id={`${titleId}-error`} role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" className="mt-4 w-full" disabled={busy || code.length !== 6}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            <div className="mt-3 flex justify-between text-sm">
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => setStep("email")}>
                Use a different email
              </button>
              <button type="button" className="font-medium text-accent hover:underline" disabled={busy} onClick={() => void sendCode()}>
                Send a new code
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
