import { createNimbleExtractor } from "../providers/nimble/extract";
import { loadWorkerConfig } from "../worker/config";

/**
 * OPT-IN live smoke test of Nimble Extract: exactly ONE request for ONE fixed,
 * harmless public page (an encyclopedia article about a public landmark; it
 * carries schema.org publication metadata).
 *
 *   NIMBLE_LIVE_SMOKE=1 npm run smoke:nimble-extract -w @verity/api
 *
 * Never part of npm test / npm run check. Uses no event, report or user data
 * and no database. Prints only safe metadata (status, timing, sizes, host,
 * booleans, precision): never the key, the page body, its title or its text.
 * Cost at the documented price: $1.00 per 1K URLs, about $0.001.
 */

const PAGE = "https://en.wikipedia.org/wiki/San_Francisco%E2%80%93Oakland_Bay_Bridge";

async function main() {
  if (process.env.NIMBLE_LIVE_SMOKE !== "1") {
    console.error("Refusing: set NIMBLE_LIVE_SMOKE=1 to make one live Nimble Extract request.");
    process.exit(2);
  }
  if (process.env.VITEST || process.env.CI) {
    console.error("Refusing: the live smoke test never runs under the test runner or CI.");
    process.exit(2);
  }
  const config = loadWorkerConfig(process.env);
  if (!config.nimble.apiKey) {
    console.error("NIMBLE_API_KEY is not set.");
    process.exit(2);
  }

  let responseBytes = 0;
  let httpStatus = 0;
  let calls = 0;
  // Measure the response size without exposing it; the body is handed on unchanged.
  const measuringFetch: typeof fetch = async (input, init) => {
    calls += 1;
    const response = await fetch(input, init);
    const buffer = await response.arrayBuffer();
    responseBytes = buffer.byteLength;
    httpStatus = response.status;
    return new Response(buffer, { status: response.status, headers: response.headers });
  };

  const extractor = createNimbleExtractor({ apiKey: config.nimble.apiKey, baseUrl: config.nimble.baseUrl, now: () => new Date(), fetch: measuringFetch });
  const started = performance.now();
  const outcome = await extractor.extract({ url: PAGE, signal: AbortSignal.timeout(60_000) });
  const elapsedMs = Math.round(performance.now() - started);

  const base = { requests: calls, httpStatus, elapsedMs, responseBytes, documentedCost: "$1.00 per 1K URLs -> about $0.001" };
  if (outcome.status !== "ok") {
    console.log(JSON.stringify({ ...base, ok: false, status: outcome.status, code: outcome.code }, null, 2));
    process.exit(1);
  }
  const page = outcome.page;
  console.log(
    JSON.stringify(
      {
        ...base,
        ok: true,
        finalUrlHost: new URL(page.finalUrl).hostname,
        redirected: page.finalUrl !== page.requestedUrl,
        mainContent: page.text.length > 0,
        mainContentChars: page.text.length,
        titleFound: page.title !== null,
        publicationMetadataFound: page.published !== null,
        publicationConflict: page.publishedConflict,
        datePrecision: page.published?.precision ?? null,
        providerRefReturned: page.ref !== null,
      },
      null,
      2,
    ),
  );
}

void main();
