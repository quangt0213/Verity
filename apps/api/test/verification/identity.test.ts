import { describe, expect, it } from "vitest";
import { normalizeResult } from "../../src/providers/nimble/normalize";
import type { NormalizedEvidence } from "../../src/verification/evidence";
import { buildSearchContext, type SearchContext, type SearchPlace } from "../../src/verification/geocoding";
import { buildEventIdentity, checkIdentity, eventName, statedDates, type IdentityInput } from "../../src/verification/identity";
import { matchLocation, placeConflict, splitLocationLabel } from "../../src/verification/text-evidence";
import { DIA_SAN_JOSE_EVENT, RECONSTRUCTED_RESULTS, UNRELATED_KEYS } from "../fixtures/dia-san-jose";
import { communityReport, hoursAgo, minutesAgo, NOW, run } from "./factories";

const SAN_JOSE: SearchPlace = { street: null, neighborhood: "Downtown", city: "San Jose", region: "California", countryCode: "US", provider: "test", retrievedAt: NOW };

function contextFor(label: string, place: SearchPlace | null = SAN_JOSE, category: IdentityInput["category"] = "festival"): SearchContext {
  return buildSearchContext({ category, title: DIA_SAN_JOSE_EVENT.title, approximateLocation: label, reportLocationLabels: [] }, place);
}

const EVENT: IdentityInput = { category: "festival", title: DIA_SAN_JOSE_EVENT.title, scheduledStartAt: null, scheduledEndAt: null };

/** Normalize one reconstructed result as the retriever would, published `minutes` ago. */
function normalized(key: string, options: { place?: SearchPlace | null; identity?: boolean; event?: Partial<IdentityInput>; minutes?: number } = {}): NormalizedEvidence {
  const r = RECONSTRUCTED_RESULTS.find((x) => x.key === key)!;
  const context = contextFor(DIA_SAN_JOSE_EVENT.label, options.place === undefined ? SAN_JOSE : options.place);
  const identity = options.identity === false ? undefined : buildEventIdentity({ ...EVENT, ...options.event }, context);
  const out = normalizeResult(
    { title: r.title, url: r.url, description: r.description, content: r.content, additional_data: { publish_date: minutesAgo(options.minutes ?? 30).toISOString() } } as never,
    { category: "festival", context, query: "q", requestId: null, now: NOW, identity },
  );
  if (!out.ok) throw new Error(`fixture ${key} did not normalize`);
  return out.evidence;
}

describe("event names", () => {
  const context = contextFor(DIA_SAN_JOSE_EVENT.label);

  it("finds the distinctive name of a named planned event, folding accents", () => {
    const name = eventName("Día San José 2026", "festival", context)!;
    expect(name.tokens).toEqual(["dia", "san", "jose"]);
    expect(name.pattern.test("Dia de San Jose returns")).toBe(true);
    expect(name.pattern.test("Día San José")).toBe(false); // patterns run on accent-folded text
    expect(name.pattern.test("Fiestas de San Jose")).toBe(false);
    expect(name.pattern.test("san jose dia")).toBe(false); // word order matters
  });

  it("treats generic or place-only titles as unnamed", () => {
    expect(eventName("Festival at the plaza tonight", "festival", context)).toBeNull();
    expect(eventName("Plaza de César Chávez festival", "festival", context)).toBeNull();
    expect(eventName("Big festival happening now", "festival", context)).toBeNull();
  });

  it("never names disruptions: incident titles keep category-based matching", () => {
    const identity = buildEventIdentity({ category: "road_closure", title: "Road blocked near Mission St", scheduledStartAt: null, scheduledEndAt: null }, context);
    expect(identity.name).toBeNull();
    expect(identity.planned).toBe(false);
  });
});

describe("the reconstructed Día San José search (10 results)", () => {
  for (const place of [SAN_JOSE, null]) {
    describe(place ? "with a derived place" : "without a geocoder", () => {
      it.each(UNRELATED_KEYS)("%s takes no stance", (key) => {
        const e = normalized(key, { place });
        expect(e.stance).toBe("context");
        expect(["uncertain", "mismatch"]).toContain(e.identity);
      });

      it("matches the event's own announcement page", () => {
        const e = normalized("announcement", { place });
        expect(e).toMatchObject({ identity: "match", stance: "supports", locationMatch: "exact", sourceClass: "OFFICIAL" });
      });
    });
  }

  it("names the failure modes: other places, other editions, same venue but another event", () => {
    expect(normalized("costa_rica")).toMatchObject({ identity: "mismatch", locationMatch: "mismatch" });
    expect(normalized("last_year").identity).toBe("mismatch");
    // Same venue, another festival: located exactly, but not this event.
    expect(normalized("same_venue_other_event")).toMatchObject({ locationMatch: "exact", identity: "uncertain", stance: "context" });
    // A city-only mention never establishes an exact location.
    expect(normalized("bay_listicle").locationMatch).toBe("unclear");
  });

  it("without the identity check, unrelated festivals would have taken a stance (the production failure)", () => {
    expect(normalized("lanzarote", { identity: false }).stance).toBe("supports");
    expect(normalized("same_venue_other_event", { identity: false })).toMatchObject({ stance: "supports", locationMatch: "exact" });
  });

  it("produces no qualifying support: the event stays UNVERIFIED", () => {
    const all = RECONSTRUCTED_RESULTS.map((r) => normalized(r.key));
    const d = run("UNVERIFIED", [communityReport(), ...all], { event: { category: "festival", firstSeenAt: hoursAgo(1) } });
    expect(d.target).toBeNull();
    expect(d.ruleId).toBe("no_qualifying_evidence");
    expect(d.facts.support).toHaveLength(0);
    // The announcement is the only record about this event; it shows the event is planned, not that it is happening.
    expect(d.facts.announcedOnly).toBe(1);
    expect(d.explanation).toContain("shows it is planned, not that it is happening now");
    expect(d.explanation).not.toMatch(/%|percent|probab/i);
  });
});

describe("correct named-event matches", () => {
  const context = contextFor(DIA_SAN_JOSE_EVENT.label);
  const identity = buildEventIdentity(EVENT, context);
  const result = (url: string, title: string, content: string, minutes = 20) => {
    const out = normalizeResult({ title, url, description: "", content, additional_data: { publish_date: minutesAgo(minutes).toISOString() } } as never, {
      category: "festival",
      context,
      query: "q",
      requestId: null,
      now: NOW,
      identity,
    });
    if (!out.ok) throw new Error("did not normalize");
    return out.evidence;
  };

  it("supports when coverage names the event at the venue as it happens, even without the word festival", () => {
    const e = result("https://local-news.example/dia", "Crowds fill downtown", "Thousands are at Plaza de César Chávez as Día de San José gets underway this morning.");
    expect(e).toMatchObject({ identity: "match", stance: "supports", locationMatch: "exact" });
  });

  it("verifies with an identified source and an independent one describing it happening now", () => {
    const official = result("https://www.sanjoseca.gov/news/dia-live", "Día San José 2026 is underway", "Día San José is happening now at Plaza de César Chávez; expect closures on Market St.");
    const news = result("https://local-news.example/dia-crowds", "Día San José draws crowds", "Día San José is drawing big crowds to Plaza de César Chávez today.");
    const d = run("UNVERIFIED", [communityReport(), official, news], { event: { category: "festival", firstSeenAt: hoursAgo(1) } });
    expect(d.target).toBe("VERIFIED");
    expect(d.ruleId).toBe("verified_independent_sources");
  });

  it("prefers the sentence that names the event, including names with street-like words", () => {
    const north = buildEventIdentity({ category: "festival", title: "North Beach Festival", scheduledStartAt: null, scheduledEndAt: null }, context);
    const out = normalizeResult(
      {
        title: "Weekend guide",
        url: "https://guide.example/w",
        description: "",
        content: "A street festival fills Plaza de César Chávez today. North Beach Festival is underway at Plaza de César Chávez with music.",
        additional_data: { publish_date: minutesAgo(15).toISOString() },
      } as never,
      { category: "festival", context, query: "q", requestId: null, now: NOW, identity: north },
    );
    expect(out.ok && out.evidence).toMatchObject({ excerpt: "North Beach Festival is underway at Plaza de César Chávez with music.", identity: "match", stance: "supports" });
  });

  it("keeps negation and cancellation working on the event's name", () => {
    expect(result("https://local-news.example/c", "Update", "Día San José was canceled at Plaza de César Chávez this morning because of rain.").stance).toBe("ended");
    expect(result("https://local-news.example/r", "Update", "Rumors that Día San José is happening at Plaza de César Chávez are unconfirmed.").stance).toBe("context");
  });
});

describe("scheduled is not occurring", () => {
  const context = contextFor(DIA_SAN_JOSE_EVENT.label);
  const start = new Date(NOW.getTime() + 3 * 24 * 60 * 60_000);
  const announcementWith = (event: Partial<IdentityInput>) => normalized("announcement", { event });

  it("an announcement never qualifies without an established schedule, even with a reporter's claimed one", () => {
    const claimed = { reportedSchedules: [{ start: new Date("2026-03-19T17:00:00Z"), end: new Date("2026-03-20T01:00:00Z") }] };
    const e = announcementWith(claimed);
    expect(e).toMatchObject({ identity: "match", stance: "supports" });
    const d = run("UNVERIFIED", [communityReport(), e], { event: { category: "festival" } });
    expect(d.facts.support).toHaveLength(0);
    expect(d.facts.announcedOnly).toBe(1);
  });

  it("before an established start, an official announcement only shows the event is planned", () => {
    const e = { ...announcementWith({}), publishedAt: hoursAgo(2) };
    const scheduled = { category: "festival" as const, scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 8 * 3600_000) };
    const before = run("UNVERIFIED", [communityReport(), e], { event: scheduled });
    expect(before.target).toBeNull();
    expect(before.facts.announcedOnly).toBe(1);
  });

  it("once the established schedule is underway, the same announcement counts as support", () => {
    const e = { ...announcementWith({}), publishedAt: hoursAgo(2) };
    const underway = { category: "festival" as const, scheduledStartAt: hoursAgo(1), scheduledEndAt: new Date(NOW.getTime() + 6 * 3600_000) };
    const d = run("UNVERIFIED", [communityReport(), e], { event: underway });
    expect(d.facts.announcedOnly).toBe(0);
    expect(d.facts.support).toHaveLength(1);
    expect(d.target).toBe("LIKELY"); // one identified lineage plus community: not VERIFIED on its own
  });

  it("present-tense coverage is not an announcement", () => {
    const e = normalized("announcement");
    const live = { ...e, excerpt: "Día San José is underway at Plaza de César Chávez with music and dancing." };
    expect(run("UNVERIFIED", [live], { event: { category: "festival" } }).facts.announcedOnly).toBe(0);
  });

  it("explicit dates outside the schedule mark another occurrence", () => {
    const identity = buildEventIdentity({ category: "festival", title: "Festival at the plaza", scheduledStartAt: null, scheduledEndAt: null, reportedSchedules: [{ start: new Date("2026-03-19T17:00:00Z"), end: null }] }, context);
    const check = (text: string) => checkIdentity({ title: null, excerpt: text, text, locationMatch: "exact" }, identity);
    expect(check("The festival at Plaza de César Chávez is on July 4, 2026.").verdict).toBe("mismatch");
    expect(check("The festival at Plaza de César Chávez is on March 19, 2026.").verdict).toBe("unchecked");
    expect(check("El festival es el 19 de marzo de 2026 en la Plaza de César Chávez.").verdict).toBe("unchecked");
    expect(check("The festival at Plaza de César Chávez starts at 10 a.m.").verdict).toBe("unchecked"); // no date: unknown, not a conflict
  });

  it("reads written dates, including future ones, ranges and Spanish", () => {
    const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 10));
    expect(iso(statedDates("March 19-21, 2026 and 4 July 2027; 19 de marzo de 2026; 2026-03-19"))).toEqual(["2026-03-19", "2026-03-21", "2027-07-04"]);
    expect(statedDates("3/19/2026 and March 19")).toEqual([]); // ambiguous or yearless: never read
  });
});

describe("location matching (A4)", () => {
  const sj = contextFor(DIA_SAN_JOSE_EVENT.label);
  const sjNoPlace = contextFor(DIA_SAN_JOSE_EVENT.label, null);

  it("splits compound labels: the venue is precise, city and state are never location evidence", () => {
    expect(splitLocationLabel("Plaza de César Chávez, San Jose, CA", sjNoPlace)).toEqual({
      precise: ["plaza de cesar chavez", "cesar chavez plaza", "plaza cesar chavez"],
      nearby: [],
    });
    expect(splitLocationLabel("Mission St & 24th St, Mission District", { city: "San Francisco", region: "California" })).toEqual({ precise: ["mission st", "24th st"], nearby: ["mission district"] });
    expect(splitLocationLabel("Mission St, CA", { city: null, region: null }).precise).toEqual(["mission st"]);
  });

  it("matches accents, word order and street abbreviations", () => {
    for (const ctx of [sj, sjNoPlace]) {
      expect(matchLocation("Crowds at Plaza de Cesar Chavez", ctx)).toBe("exact");
      expect(matchLocation("Crowds at César Chávez Plaza", ctx)).toBe("exact");
      expect(matchLocation("PLAZA DE CÉSAR CHÁVEZ", ctx)).toBe("exact");
      // The bare name also names streets and holidays: not the venue.
      expect(matchLocation("Cesar Chavez Day parade on Cesar Chavez St", ctx)).toBe("unclear");
    }
    const sf = buildSearchContext({ category: "road_closure", title: "x", approximateLocation: "Mission St & 24th St", reportLocationLabels: [] }, null);
    expect(matchLocation("Mission Street and 24th Street are closed", sf)).toBe("exact");
  });

  it("a city-only mention is never an exact location", () => {
    expect(matchLocation("Something is happening in San Jose, CA", sj)).toBe("unclear");
    expect(matchLocation("Something is happening in San José", sjNoPlace)).toBe("unclear");
    const cityOnly = buildSearchContext({ category: "festival", title: "x", approximateLocation: "San Jose, CA", reportLocationLabels: [] }, null);
    expect(cityOnly.locationTerms).toEqual(["San Jose, CA"]);
    expect(matchLocation("A festival in San Jose", cityOnly)).toBe("unclear");
  });

  it("tells San José, California from San José elsewhere", () => {
    for (const ctx of [sj, sjNoPlace]) {
      expect(placeConflict("Festival in San José, Costa Rica tonight", ctx)).toBe(true);
      expect(placeConflict("A fair in San Jose, Ill., this weekend", ctx)).toBe(true);
      expect(placeConflict("Festival in San Jose, Calif., tonight", ctx)).toBe(false);
      expect(placeConflict("Festival in San Jose, CA tonight", ctx)).toBe(false);
      expect(placeConflict("Festival in San Jose, Santa Clara County", ctx)).toBe(false);
      expect(placeConflict("San Jose, la ciudad, celebra", ctx)).toBe(false);
      // Both mentioned: the page also places it in our state, so no conflict.
      expect(placeConflict("Sister cities San José, Costa Rica and San Jose, California", ctx)).toBe(false);
      expect(matchLocation("Festival de la Luz in San José, Costa Rica", ctx)).toBe("mismatch");
    }
  });
});

describe("existing incident categories keep working", () => {
  it("an unnamed road closure is unchecked by identity and still verifies on located, timely evidence", () => {
    const context = buildSearchContext({ category: "road_closure", title: "Road blocked near Mission St", approximateLocation: "Mission St & 22nd St", reportLocationLabels: [] }, { ...SAN_JOSE, city: "San Francisco" });
    const identity = buildEventIdentity({ category: "road_closure", title: "Road blocked near Mission St", scheduledStartAt: null, scheduledEndAt: null }, context);
    const out = normalizeResult(
      { title: "Mission St closed", url: "https://dot.ca.gov/alerts/1", description: "", content: "All lanes of Mission St are closed at 22nd St after a water main break.", additional_data: { publish_date: minutesAgo(10).toISOString() } } as never,
      { category: "road_closure", context, query: "q", requestId: null, now: NOW, identity },
    );
    expect(out.ok && out.evidence).toMatchObject({ identity: "unchecked", stance: "supports", locationMatch: "exact", isPrimary: true });
    expect(run("UNVERIFIED", [out.ok ? out.evidence : (null as never)]).target).toBe("VERIFIED");
  });
});
