import type { Plugin } from "vite";

/**
 * Anything prefixed VITE_ is compiled into the public bundle. Refuse to build
 * when a variable with a credential-like name carries that prefix, so a secret
 * can't be shipped to browsers by a naming mistake.
 */
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|CREDENTIAL|API_?KEY|ACCESS_?KEY|DATABASE_URL|_KEY$)/i;

export function findSecretLikePublicVars(env: Record<string, string>): string[] {
  return Object.keys(env).filter((name) => name.startsWith("VITE_") && SECRET_NAME.test(name));
}

export function publicEnvGuard(env: Record<string, string>): Plugin {
  return {
    name: "verity:public-env-guard",
    config(config) {
      const offenders = findSecretLikePublicVars(env);
      if (offenders.length > 0) {
        throw new Error(
          `Refusing to start: ${offenders.join(", ")} would be exposed to every browser. ` +
            "Secrets belong to the Verity service (apps/api), never to VITE_* variables.",
        );
      }
      if (config.envPrefix !== undefined && config.envPrefix !== "VITE_") {
        throw new Error("envPrefix must stay 'VITE_' so only intentionally public values reach the bundle.");
      }
    },
  };
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface CspInputs {
  apiUrl?: string;
  mapStyleUrls: string[];
  extraMapOrigins: string[];
}

/**
 * Content-Security-Policy for the production bundle. It is delivered as a
 * <meta> tag because the Maypop host, not this app, controls response headers.
 * frame-ancestors, X-Content-Type-Options and Permissions-Policy cannot be set
 * from a meta tag; see SECURITY.md.
 */
export function buildCsp({ apiUrl, mapStyleUrls, extraMapOrigins }: CspInputs): string {
  const maypop = "https://*.maypop.ai";
  const connect = new Set<string>(["'self'", maypop]);
  const apiOrigin = originOf(apiUrl);
  if (apiOrigin?.includes("[")) {
    // CSP source expressions can't contain IPv6 literals; the browser would
    // silently drop the entry and block every API call.
    throw new Error("VITE_VERITY_API_URL must use a hostname or IPv4 address, not an IPv6 literal (CSP can't express it).");
  }
  if (apiOrigin) connect.add(apiOrigin);
  for (const url of [...mapStyleUrls, ...extraMapOrigins]) {
    const origin = originOf(url);
    if (origin) connect.add(origin);
  }
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", maypop],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [...connect],
    "worker-src": ["'self'", "blob:"],
    "child-src": ["'self'", "blob:"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function cspMetaPlugin(inputs: CspInputs, enabled: boolean): Plugin {
  return {
    name: "verity:csp-meta",
    apply: "build",
    transformIndexHtml() {
      if (!enabled) return [];
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: buildCsp(inputs) },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
