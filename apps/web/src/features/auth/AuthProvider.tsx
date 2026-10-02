import { useQueryClient } from "@tanstack/react-query";
import type { AuthSession } from "@verity/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useApi } from "../../api/ApiProvider";
import type { WriteResult } from "../../api/types";
import { SignInDialog } from "./SignInDialog";

interface AuthContextValue {
  /** True when the data source has Verity accounts (the real service). */
  available: boolean;
  session: AuthSession | null;
  /** Open the sign-in dialog; resolves true once signed in, false if dismissed. */
  requestSignIn: (reason?: string) => Promise<boolean>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const noSession = () => null;
const noSubscribe = () => () => undefined;

/**
 * Verity's own account state. Completely separate from the Maypop profile:
 * nothing here reads or sends Maypop identity.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const auth = api.auth;
  const session = useSyncExternalStore(auth?.subscribe ?? noSubscribe, auth?.getSession ?? noSession, noSession);
  const [dialog, setDialog] = useState<{ reason?: string } | null>(null);
  const pending = useRef<((signedIn: boolean) => void) | null>(null);

  const finish = useCallback((signedIn: boolean) => {
    setDialog(null);
    pending.current?.(signedIn);
    pending.current = null;
  }, []);

  const requestSignIn = useCallback(
    (reason?: string) => {
      if (!auth) return Promise.resolve(false);
      if (auth.getSession()) return Promise.resolve(true);
      pending.current?.(false);
      setDialog({ reason });
      return new Promise<boolean>((resolve) => {
        pending.current = resolve;
      });
    },
    [auth],
  );

  const signOut = useCallback(async () => {
    await auth?.signOut();
    // Drop anything cached for the previous account.
    queryClient.removeQueries({ queryKey: ["account"] });
  }, [auth, queryClient]);

  const value = useMemo(
    () => ({ available: Boolean(auth), session, requestSignIn, signOut }),
    [auth, session, requestSignIn, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {dialog && auth && <SignInDialog auth={auth} reason={dialog.reason} onDone={finish} />}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/**
 * Run a protected write. If the service says sign-in is needed, ask the
 * person to sign in and then retry the same action, so they land exactly
 * where they were. Resolves null if they close the sign-in dialog.
 */
export function useGuardedWrite() {
  const { available, requestSignIn } = useAuth();
  return useCallback(
    async <T,>(run: () => Promise<WriteResult<T>>, reason: string): Promise<WriteResult<T> | null> => {
      const first = await run();
      if (first.ok || first.error.code !== "auth_required" || !available) return first;
      const signedIn = await requestSignIn(reason);
      if (!signedIn) return null;
      return run();
    },
    [available, requestSignIn],
  );
}
