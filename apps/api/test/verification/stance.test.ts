import type { EventCategory, EvidenceStance } from "@verity/contracts";
import { describe, expect, it } from "vitest";
import { classifyStance } from "../../src/verification/stance";

const cases: Array<[string, EventCategory, EvidenceStance, string]> = [
  // Plain, current statements.
  ["Northbound lanes of Highway 101 are closed near Cesar Chavez.", "road_closure", "supports", "plain closure"],
  ["Crews are battling a two-alarm fire on Mission Street.", "fire", "supports", "plain fire"],
  ["About 4,000 customers are without power in the Sunset District.", "power_outage", "supports", "plain outage"],

  // Negation must never become support.
  ["Highway 101 is not closed, despite reports on social media.", "road_closure", "contradicts", "not closed"],
  ["There is no flooding on Embarcadero this morning, officials confirmed.", "flooding", "contradicts", "no flooding"],
  ["The bridge was never closed, a Caltrans spokesperson said.", "road_closure", "contradicts", "never closed"],
  ["Reports of a fire at the station were false.", "fire", "contradicts", "false report"],
  ["Mission Street is no longer closed.", "road_closure", "ended", "no longer closed"],

  // Ended / restored / reopened.
  ["Mission Street reopened to traffic at 9 a.m.", "road_closure", "ended", "reopened"],
  ["Power has been restored to all customers in the Richmond District.", "power_outage", "ended", "outage restored"],
  ["The grass fire is 100% contained, according to CAL FIRE.", "fire", "ended", "fire contained"],
  ["Flood waters have receded from the underpass.", "flooding", "ended", "receded"],

  // Temporal reversal and history are not current support.
  ["The road was closed yesterday but reopened this morning.", "road_closure", "ended", "closed then reopened"],
  ["In 2019 the same intersection was closed for months of repairs.", "road_closure", "context", "historical year"],
  ["The street was closed last week for a film shoot.", "road_closure", "context", "last week"],
  ["Mission Street has not reopened yet.", "road_closure", "context", "not reopened (unclear)"],

  // Claims the publisher does not itself assert.
  ["Residents claim that the bridge is closed, but the agency has not confirmed it.", "road_closure", "context", "claims that"],
  ["Unconfirmed reports describe a fire near the pier.", "fire", "context", "unconfirmed"],
  ['"The whole street is closed," one viral post said.', "road_closure", "context", "quoted claim"],
  ["Rumors of a blackout spread online Tuesday.", "power_outage", "context", "rumor"],

  // Hypothetical / forecast.
  ["The road may be closed if the rain continues.", "road_closure", "context", "may be closed"],
  ["Forecasters issued a flood watch for low-lying areas.", "flooding", "context", "flood watch"],
  ["The fire is 40% contained and still threatening homes.", "fire", "supports", "partly contained is still burning"],

  // Event words inside organization or role names are not the event.
  ["Fire crews responded to a medical call on Mission Street.", "fire", "context", "fire crews (name use)"],
  ["Officials from the county fire department met residents.", "fire", "context", "fire department (name use)"],

  // Nothing about the event.
  ["The city council met to discuss the budget.", "road_closure", "context", "irrelevant"],
  ["", "crash", "context", "empty"],
];

describe("conservative stance classification", () => {
  it.each(cases)("%s → %s (%s)", (sentence, category, expected) => {
    expect(classifyStance(sentence, category)).toBe(expected);
  });

  it("only uses words for the event's own category", () => {
    expect(classifyStance("Two lanes are closed after a crash.", "flooding")).toBe("context");
  });
});
