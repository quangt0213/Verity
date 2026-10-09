import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

/**
 * Throwaway CA files for database TLS tests. The "valid" bundle is two public
 * root certificates from Node's own trust store, so no certificate or key is
 * committed. Call `cleanup()` in afterAll.
 */
export function caFixture() {
  const dir = mkdtempSync(join(tmpdir(), "verity-ca-"));
  const write = (name: string, contents: string) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  };
  const bundle = `${rootCertificates[0]}\n${rootCertificates[1]}\n`;
  return {
    dir,
    bundle,
    valid: write("ca-bundle.pem", bundle),
    write,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
