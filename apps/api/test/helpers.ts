import { buildDemoEvents } from "@verity/contracts/demo";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app";
import { memoryMailer } from "../src/auth/mailer";
import { loadConfig } from "../src/config";
import { createDatabase, type Database } from "../src/db/client";
import { insertDemoEvents } from "../src/db/seed";

export const ORIGIN = "https://app.verity.test";
export const INTERNAL_TOKEN = "internal-test-token-0123456789abcdef0123456789";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  mailer: ReturnType<typeof memoryMailer>;
  request: (options: InjectOptions & { token?: string }) => Promise<InjectResponse>;
  signIn: (email: string) => Promise<string>;
  userIdFor: (token: string) => Promise<string>;
  close: () => Promise<void>;
  /** Close only the database, leaving the app running (failure-path tests). */
  closeDatabase: () => Promise<void>;
}

export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: "test",
    VERITY_ALLOWED_ORIGINS: ORIGIN,
    INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    ...env,
  });
  const database = createDatabase("pglite:memory");
  await database.migrate();
  const mailer = memoryMailer();
  const app = await buildApp({ config, db: database.db, mailer });

  const request: TestContext["request"] = async ({ token, headers, ...options }) =>
    await app.inject({
      ...options,
      headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });

  // Each simulated user signs in from its own address so per-network auth
  // limits don't interfere with tests that need many accounts.
  let addressCounter = 0;
  async function signIn(email: string): Promise<string> {
    const n = ++addressCounter;
    const remoteAddress = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
    const start = await request({ method: "POST", url: "/api/v1/auth/email/start", payload: { email }, remoteAddress });
    if (start.statusCode !== 202) throw new Error(`start failed: ${start.statusCode} ${start.body}`);
    const code = mailer.lastCodeFor(email.toLowerCase());
    if (!code) throw new Error("no code captured");
    const verify = await request({ method: "POST", url: "/api/v1/auth/email/verify", payload: { email, code }, remoteAddress });
    if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
    return verify.json().token as string;
  }

  async function userIdFor(token: string): Promise<string> {
    const { resolveIdentity } = await import("../src/auth/identity");
    const { createAuth } = await import("../src/auth/auth");
    const auth = createAuth({ db: database.db, config, mailer, log: app.log });
    const identity = await resolveIdentity(auth, { headers: { authorization: `Bearer ${token}` } } as never);
    if (!identity) throw new Error("token not valid");
    return identity.userId;
  }

  return {
    app,
    db: database.db,
    mailer,
    request,
    signIn,
    userIdFor,
    close: async () => {
      await app.close();
      await database.close().catch(() => undefined);
    },
    closeDatabase: () => database.close(),
  };
}

export async function seedDemo(db: Database) {
  const demo = buildDemoEvents(new Date());
  await insertDemoEvents(db, demo);
  return demo;
}

export const SF_BBOX = "-122.55,37.7,-122.35,37.83";

export const validReport = {
  category: "road_closure",
  title: "Road blocked near Mission St",
  description: "Two lanes closed, police directing traffic.",
  location: { coordinates: { latitude: 37.7601, longitude: -122.4189 }, label: "Mission St & 22nd St" },
};
