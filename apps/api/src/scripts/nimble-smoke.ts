import { createNimbleSearchClient } from "../providers/nimble/client";
import { parsePublishDate } from "../providers/nimble/normalize";
import { loadWorkerConfig } from "../worker/config";

/**
 * OPT-IN live smoke test of Nimble Search: exactly ONE fixed, harmless query.
 *
 *   NIMBLE_LIVE_SMOKE=1 npm run smoke:nimble -w @verity/api
 *
 * Never part of npm test / npm run check. Uses no event, report or user data
 * and no database. Prints only safe metadata (status, counts, field names,
 * timing): never the key, and never response bodies, titles or URLs.
 * Cost at the documented price (standard depth): about $0.005.
 */

const QUERY = "San Francisco Bay Bridge traffic";

async function main() {
  if (process.env.NIMBLE_LIVE_SMOKE !== "1") {
    console.error("Refusing: set NIMBLE_LIVE_SMOKE=1 to make one live Nimble Search request.");
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

  const client = createNimbleSearchClient({ apiKey: config.nimble.apiKey, baseUrl: config.nimble.baseUrl });
  const started = performance.now();
  const outcome = await client.search({ query: QUERY, searchDepth: "standard", maxResults: 5, country: "US", timeRange: "week" }, AbortSignal.timeout(45_000));
  const elapsedMs = Math.round(performance.now() - started);

  if (!outcome.ok) {
    console.log(JSON.stringify({ requests: 1, ok: false, kind: outcome.kind, code: outcome.code, retryAfterSeconds: outcome.retryAfterSeconds, elapsedMs }, null, 2));
    process.exit(1);
  }
  const now = new Date();
  const additionalKeys = new Set<string>();
  for (const r of outcome.results) for (const key of Object.keys(r.additional_data ?? {})) additionalKeys.add(key);
  console.log(
    JSON.stringify(
      {
        requests: 1,
        ok: true,
        elapsedMs,
        requestIdReturned: outcome.requestId !== null,
        results: outcome.results.length,
        resultsFailingValidation: outcome.droppedInvalid,
        validated: outcome.droppedInvalid === 0,
        withContent: outcome.results.filter((r) => r.content.trim().length > 0).length,
        averageContentChars: Math.round(outcome.results.reduce((n, r) => n + r.content.length, 0) / Math.max(1, outcome.results.length)),
        withDescription: outcome.results.filter((r) => r.description.trim().length > 0).length,
        averageDescriptionChars: Math.round(outcome.results.reduce((n, r) => n + r.description.length, 0) / Math.max(1, outcome.results.length)),
        invalidFieldPaths: outcome.invalidFieldPaths,
        withAdditionalData: outcome.results.filter((r) => r.additional_data && Object.keys(r.additional_data).length > 0).length,
        additionalDataFieldNames: [...additionalKeys].sort(),
        withParseablePublishDate: outcome.results.filter((r) => parsePublishDate(r.additional_data ?? null, now) !== null).length,
      },
      null,
      2,
    ),
  );
}

void main();
