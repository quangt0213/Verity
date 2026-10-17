/**
 * Small, reviewed lists of place names used to tell WHICH place a text is
 * about when a city name is ambiguous ("San José, CA" vs "San José, Costa
 * Rica"). Deliberately short: US states (names, USPS codes and AP-style
 * abbreviations) and countries whose names commonly appear as a qualifier.
 * All entries are lowercase and accent-folded, matching normalizePlaceText.
 * Change them by pull request, with tests.
 */

/** [state name, USPS code, AP abbreviation or null]. */
const US_STATES: Array<[string, string, string | null]> = [
  ["alabama", "al", "ala"],
  ["alaska", "ak", null],
  ["arizona", "az", "ariz"],
  ["arkansas", "ar", "ark"],
  ["california", "ca", "calif"],
  ["colorado", "co", "colo"],
  ["connecticut", "ct", "conn"],
  ["delaware", "de", "del"],
  ["florida", "fl", "fla"],
  ["georgia", "ga", null],
  ["hawaii", "hi", null],
  ["idaho", "id", null],
  ["illinois", "il", "ill"],
  ["indiana", "in", "ind"],
  ["iowa", "ia", null],
  ["kansas", "ks", "kan"],
  ["kentucky", "ky", null],
  ["louisiana", "la", null],
  ["maine", "me", null],
  ["maryland", "md", null],
  ["massachusetts", "ma", "mass"],
  ["michigan", "mi", "mich"],
  ["minnesota", "mn", "minn"],
  ["mississippi", "ms", "miss"],
  ["missouri", "mo", null],
  ["montana", "mt", "mont"],
  ["nebraska", "ne", "neb"],
  ["nevada", "nv", "nev"],
  ["new hampshire", "nh", null],
  ["new jersey", "nj", null],
  ["new mexico", "nm", null],
  ["new york", "ny", null],
  ["north carolina", "nc", null],
  ["north dakota", "nd", null],
  ["ohio", "oh", null],
  ["oklahoma", "ok", "okla"],
  ["oregon", "or", "ore"],
  ["pennsylvania", "pa", null],
  ["rhode island", "ri", null],
  ["south carolina", "sc", null],
  ["south dakota", "sd", null],
  ["tennessee", "tn", "tenn"],
  ["texas", "tx", null],
  ["utah", "ut", null],
  ["vermont", "vt", null],
  ["virginia", "va", null],
  ["washington", "wa", "wash"],
  ["west virginia", "wv", null],
  ["wisconsin", "wi", "wis"],
  ["wyoming", "wy", "wyo"],
  ["district of columbia", "dc", null],
];

/** Countries (and a few well-known island groups) that appear as place qualifiers. */
export const COUNTRIES: readonly string[] = [
  "united states",
  "usa",
  "mexico",
  "canada",
  "costa rica",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "panama",
  "cuba",
  "puerto rico",
  "dominican republic",
  "colombia",
  "venezuela",
  "ecuador",
  "peru",
  "bolivia",
  "chile",
  "argentina",
  "uruguay",
  "paraguay",
  "brazil",
  "spain",
  "canary islands",
  "portugal",
  "france",
  "italy",
  "germany",
  "united kingdom",
  "uk",
  "ireland",
  "philippines",
  "australia",
  "new zealand",
  "japan",
  "china",
  "india",
];

export interface StateNames {
  name: string;
  forms: string[];
}

/** Every written form of a US state ("california", "ca", "calif"), or null if the text names no state. */
export function usState(text: string): StateNames | null {
  const t = text.trim();
  for (const [name, code, ap] of US_STATES) {
    if (t === name || t === code || (ap !== null && t === ap)) return { name, forms: [name, code, ...(ap ? [ap] : [])] };
  }
  return null;
}

export function isCountry(text: string): boolean {
  return COUNTRIES.includes(text.trim());
}

/** "United States" and its forms: a US place qualified this way is still in the US. */
export function isUnitedStates(text: string): boolean {
  return ["united states", "usa", "us", "u s", "u s a"].includes(text.trim());
}
