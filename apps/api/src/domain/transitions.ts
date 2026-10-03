import type { EventStatus } from "@verity/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { eventStateTransitions, events, eventTimeline, type ActorType } from "../db/schema";
import { STATUS_LABEL } from "./labels";
import { checkTransition } from "./state-machine";

export interface Actor {
  type: ActorType;
  /** Internal audit only; never exposed publicly. */
  userId?: string | null;
}

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "conflict" | "not_found",
  ) {
    super(message);
  }
}

/** Allow status writes for the rest of this transaction only (see the events_status_guard trigger). */
async function allowStatusWrite(tx: Tx, on: boolean) {
  await tx.execute(sql`select set_config('verity.transition_in_progress', ${on ? "on" : "off"}, true)`);
}

/**
 * Record an event's creation in the audit trail. New events always start
 * UNVERIFIED (also enforced by the database trigger).
 */
export async function recordCreation(tx: Tx, eventId: string, reason: string, actor: Actor) {
  await tx.insert(eventStateTransitions).values({
    eventId,
    fromStatus: null,
    toStatus: "UNVERIFIED",
    reason,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
  });
}

/**
 * The one place an event's status changes. It validates the edge and the
 * actor, applies the change with optimistic concurrency (expected current
 * status), writes the audit row and the user-facing timeline entry, all in the
 * caller's transaction. `timelineDetail` is the user-facing text (defaults to
 * the audit reason).
 */
export async function transitionEvent(
  tx: Tx,
  input: { eventId: string; to: EventStatus; reason: string; actor: Actor; expectedFrom?: EventStatus; timelineDetail?: string },
): Promise<{ from: EventStatus; to: EventStatus; transitionId: string }> {
  const [current] = await tx
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, input.eventId))
    .for("update");
  if (!current) throw new TransitionError("Event not found", "not_found");
  const from = current.status as EventStatus;
  if (input.expectedFrom && input.expectedFrom !== from) {
    throw new TransitionError(`Expected ${input.expectedFrom} but event is ${from}`, "conflict");
  }
  const check = checkTransition(from, input.to, input.actor.type);
  if (!check.ok) throw new TransitionError(check.reason, "invalid");

  const now = new Date();
  await allowStatusWrite(tx, true);
  const updated = await tx
    .update(events)
    .set({
      status: input.to,
      lastUpdatedAt: now,
      updatedAt: now,
      ...(input.to === "VERIFIED" || input.to === "LIKELY" ? { lastVerifiedAt: now } : {}),
    })
    .where(and(eq(events.id, input.eventId), eq(events.status, from)))
    .returning({ id: events.id });
  await allowStatusWrite(tx, false);
  if (updated.length !== 1) throw new TransitionError("Event changed concurrently", "conflict");

  const [audit] = await tx
    .insert(eventStateTransitions)
    .values({
      eventId: input.eventId,
      fromStatus: from,
      toStatus: input.to,
      reason: input.reason,
      actorType: input.actor.type,
      actorUserId: input.actor.userId ?? null,
      createdAt: now,
    })
    .returning({ id: eventStateTransitions.id });
  await tx.insert(eventTimeline).values({
    eventId: input.eventId,
    at: now,
    kind: "status_changed",
    label: `Status changed to ${STATUS_LABEL[input.to]}`,
    detail: (input.timelineDetail ?? input.reason).slice(0, 1000),
    fromStatus: from,
    toStatus: input.to,
    actorType: input.actor.type,
  });
  return { from, to: input.to, transitionId: audit!.id };
}
