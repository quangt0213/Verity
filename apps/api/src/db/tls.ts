import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isLocalDatabase } from "./target-guard";

/**
 * Certificate verification for PostgreSQL connections.
 *
 * Every connection to a NON-LOCAL database verifies the server's certificate
 * chain and host name against the CA bundle named by VERITY_DB_CA_PATH,
 * whatever NODE_ENV is and whatever `sslmode` the URL carries. postgres.js
 * treats `sslmode=require` as "encrypt, don't verify"; the explicit `ssl`
 * option built in db/client.ts overrides the URL, so the URL can't weaken it.
 *
 * Local databases (PGlite, Postgres on a loopback address) need no CA.
 */

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export class DatabaseTlsError extends Error {}

/**
 * The PEM CA bundle for `databaseUrl`: null for a local database, otherwise the
 * validated certificates from `caPath`. Problems are appended to `problems`
 * and name the variable only, never the path or the file's contents.
 */
export function resolveDatabaseCa(databaseUrl: string, caPath: string | undefined, problems: string[]): string | null {
  if (!databaseUrl || isLocalDatabase(databaseUrl)) return null;
  const path = caPath?.trim();
  if (!path) {
    problems.push("VERITY_DB_CA_PATH is required for a remote database (the CA certificate that verifies its TLS certificate)");
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    problems.push("VERITY_DB_CA_PATH could not be read");
    return null;
  }
  if (PEM_PRIVATE_KEY.test(text)) {
    problems.push("VERITY_DB_CA_PATH must contain CA certificates only, never a private key");
    return null;
  }
  const certificates = text.match(PEM_CERTIFICATE) ?? [];
  if (certificates.length === 0) {
    problems.push("VERITY_DB_CA_PATH does not contain a PEM certificate");
    return null;
  }
  for (const pem of certificates) {
    try {
      new X509Certificate(pem);
    } catch {
      problems.push("VERITY_DB_CA_PATH contains a certificate that cannot be parsed");
      return null;
    }
  }
  return certificates.join("\n");
}
