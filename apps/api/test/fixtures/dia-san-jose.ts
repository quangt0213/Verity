/**
 * RECONSTRUCTED fixture, not real provider output.
 *
 * The first live verification of a planned event (title "Día San José 2026",
 * location "Plaza de César Chávez, San Jose, CA", category festival, no
 * schedule) searched "festival Plaza de César Chávez San Jose CA" and got 10
 * external sources, mostly unrelated festivals elsewhere, several of them
 * stance-tagged "supports". The real records are not in this repository and
 * were never fetched from production. These ten results are written by hand
 * to reproduce the same failure modes: unrelated festivals abroad, other
 * places called San José, a festival with the same venue but another name,
 * last year's edition, generic listicles, and the real event's own
 * announcement page. Every URL uses a reserved example domain except the
 * official-registry domain, which is needed to exercise source classes; none
 * of the text is copied from a real page.
 */

export interface ReconstructedResult {
  /** Short label used by tests. */
  key: string;
  title: string;
  url: string;
  description: string;
  content: string;
}

export const DIA_SAN_JOSE_EVENT = {
  category: "festival",
  title: "Día San José 2026",
  label: "Plaza de César Chávez, San Jose, CA",
} as const;

export const RECONSTRUCTED_RESULTS: readonly ReconstructedResult[] = [
  {
    key: "lanzarote",
    title: "Lanzarote music festival fills Arrecife this weekend",
    url: "https://islands-news.example/lanzarote-festival",
    description: "The festival is underway in Arrecife.",
    content: "The Lanzarote music festival is underway in Arrecife, Lanzarote, Canary Islands, Spain, with concerts on the seafront all weekend.",
  },
  {
    key: "costa_rica",
    title: "Festival de la Luz lights up San José",
    url: "https://centralamerica-today.example/festival-de-la-luz",
    description: "Crowds gather downtown.",
    content: "The Festival de la Luz is happening now in downtown San José, Costa Rica, with floats and music along Avenida Segunda.",
  },
  {
    key: "los_cabos",
    title: "Fiestas Tradicionales de San José del Cabo",
    url: "https://baja-events.example/san-jose-del-cabo",
    description: "Traditional festival in Los Cabos.",
    content: "The traditional festival in San José del Cabo, Mexico continues today with rides, food and music in the town plaza.",
  },
  {
    key: "world_listicle",
    title: "The best festivals around the world this weekend",
    url: "https://travel-lists.example/festivals-this-weekend",
    description: "From Lanzarote to Rio.",
    content: "From Lanzarote to Rio, festival season is in full swing this weekend, and every festival on this list is open to visitors.",
  },
  {
    key: "plaza_de_mayo",
    title: "Festival draws crowds to Plaza de Mayo",
    url: "https://southern-cone.example/plaza-de-mayo-festival",
    description: "Buenos Aires festival.",
    content: "A free festival is drawing crowds to Plaza de Mayo in Buenos Aires, Argentina today.",
  },
  {
    key: "chavez_day_phoenix",
    title: "César Chávez Day festival in Phoenix",
    url: "https://desert-daily.example/chavez-day",
    description: "Community celebration.",
    content: "The César Chávez Day festival is happening today in Phoenix, Ariz., with music and food trucks.",
  },
  {
    key: "same_venue_other_event",
    title: "Summer jazz festival returns downtown",
    url: "https://bay-music.example/jazz-fest",
    description: "Jazz on the plaza.",
    content: "The San Jose summer jazz festival is underway at Plaza de César Chávez with three stages of live music.",
  },
  {
    key: "last_year",
    title: "Día San José 2025 recap",
    url: "https://sj-community.example/dia-san-jose-2025",
    description: "Last year's celebration.",
    content: "Día San José 2025 drew thousands to Plaza de César Chávez on March 19, 2025 for the festival.",
  },
  {
    key: "bay_listicle",
    title: "Bay Area festivals this weekend",
    url: "https://weekend-guide.example/bay-area-festivals",
    description: "Things to do.",
    content: "Bay Area festivals this weekend: the Oakland art festival, a pumpkin festival in Half Moon Bay and more festival fun around San Jose.",
  },
  {
    key: "announcement",
    title: "Día San José 2026",
    url: "https://www.sanjoseca.gov/news/dia-san-jose-2026",
    description: "City event announcement.",
    content: "Día San José 2026 will be held at Plaza de César Chávez in downtown San Jose on March 19, 2026, from 10 a.m. to 6 p.m.",
  },
];

/** Results that are about other events, places or editions: none may ever take a stance for Día San José 2026. */
export const UNRELATED_KEYS = RECONSTRUCTED_RESULTS.map((r) => r.key).filter((k) => k !== "announcement");
