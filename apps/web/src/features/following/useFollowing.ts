import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useApi } from "../../api/ApiProvider";
import { useToast } from "../../components/ui/Toast";
import { useAuth, useGuardedWrite } from "../auth/AuthProvider";

/** Query key prefix for anything tied to the signed-in account. */
export const accountKeys = {
  following: (token: string | null) => ["account", "following", token ?? "device"] as const,
  mySignals: (eventId: string, token: string | null) => ["account", "signals", eventId, token ?? "device"] as const,
};

/**
 * Followed events. With the Verity service they belong to the signed-in
 * account (sign-in required); in demo mode they stay on this device.
 */
export function useFollowingList() {
  const api = useApi();
  const { available, session } = useAuth();
  const enabled = !available || session !== null;
  return useQuery({
    queryKey: accountKeys.following(session?.token ?? null),
    queryFn: ({ signal }) => api.listFollowing(signal),
    enabled,
    retry: false,
  });
}

export function useFollowToggle() {
  const api = useApi();
  const queryClient = useQueryClient();
  const guarded = useGuardedWrite();
  const toast = useToast();
  return useCallback(
    async (eventId: string, follow: boolean) => {
      const result = await guarded(() => api.setFollowing(eventId, follow), "Sign in to follow events");
      if (!result) return;
      if (!result.ok) {
        toast.show(result.error.message, "warning");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["account", "following"] });
      toast.show(
        follow ? (result.simulated ? "Following. Saved on this device." : "Following. Saved to your Verity account.") : "Unfollowed",
        "info",
      );
    },
    [api, guarded, queryClient, toast],
  );
}
