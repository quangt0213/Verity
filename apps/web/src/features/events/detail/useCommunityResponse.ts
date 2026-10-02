import { useQueryClient } from "@tanstack/react-query";
import type { CommunityResponseInput, CommunityResponseKind } from "@verity/contracts";
import { useCallback, useState } from "react";
import { useApi } from "../../../api/ApiProvider";
import type { WriteError } from "../../../api/types";
import { eventKeys } from "../queries";

export type ResponseState = "sending" | "recorded" | "simulated";

export type RespondOutcome = { ok: true; simulated: boolean } | { ok: false; error: WriteError };

/**
 * Optimistic only where it can't imply verification: the viewer immediately
 * sees their own response as "sending", but no count or status changes until
 * the service confirms, and status changes never come from here at all.
 */
export function useCommunityResponse(eventId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [states, setStates] = useState<Partial<Record<CommunityResponseKind, ResponseState>>>({});

  const respond = useCallback(
    async (input: CommunityResponseInput): Promise<RespondOutcome> => {
      const kind = input.kind;
      setStates((s) => ({ ...s, [kind]: "sending" }));
      const result = await api.respond(eventId, input);
      if (result.ok) {
        // Free-text updates can be sent again; one-off responses stay marked.
        setStates((s) => {
          const next = { ...s, [kind]: result.simulated ? "simulated" : "recorded" } as typeof s;
          if (kind === "update") delete next.update;
          return next;
        });
        await queryClient.invalidateQueries({ queryKey: eventKeys.all });
        return { ok: true, simulated: result.simulated };
      }
      setStates((s) => {
        const next = { ...s };
        delete next[kind];
        return next;
      });
      return { ok: false, error: result.error };
    },
    [api, eventId, queryClient],
  );

  return { respond, states, writePolicy: api.writePolicy };
}
