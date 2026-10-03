import type { Maypop as MaypopSdk } from "@basilica-digital/maypop-sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { connectMaypop, CONNECTING, shareLink, snapshotFrom, type ConnectOptions, type MaypopSnapshot, type ShareResult } from "./session";

interface MaypopContextValue extends MaypopSnapshot {
  signIn: () => void;
  share: (path: string, title: string) => Promise<ShareResult>;
}

const MaypopContext = createContext<MaypopContextValue | null>(null);

export function MaypopProvider({ children, connect = connectMaypop }: { children: ReactNode; connect?: (o?: ConnectOptions) => ReturnType<typeof connectMaypop> }) {
  const [snapshot, setSnapshot] = useState<MaypopSnapshot>(CONNECTING);
  const sdkRef = useRef<MaypopSdk | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];
    connect().then(({ sdk, snapshot: initial }) => {
      if (cancelled) return;
      sdkRef.current = sdk;
      setSnapshot(initial);
      if (!sdk) return;
      const refresh = () => setSnapshot(snapshotFrom(sdk));
      unsubscribers.push(sdk.on("modechange", refresh), sdk.on("themechange", refresh));
      unsubscribers.push(
        sdk.on("revoked", () => setSnapshot((s) => ({ ...s, viewer: null, mode: "read-only", signInRequired: false }))),
      );
    });
    return () => {
      cancelled = true;
      unsubscribers.forEach((off) => off());
    };
  }, [connect]);

  const signIn = useCallback(() => sdkRef.current?.signIn(), []);
  const share = useCallback((path: string, title: string) => shareLink(sdkRef.current, path, title), []);

  const value = useMemo(() => ({ ...snapshot, signIn, share }), [snapshot, signIn, share]);
  return <MaypopContext.Provider value={value}>{children}</MaypopContext.Provider>;
}

export function useMaypop(): MaypopContextValue {
  const ctx = useContext(MaypopContext);
  if (!ctx) throw new Error("useMaypop must be used within MaypopProvider");
  return ctx;
}
