import { providerFor } from "./db-provider";
import { storageProviderId } from "./storage/select";

/**
 * What this deployment is, and whether it is configured well enough to run.
 *
 * A desktop install configures itself — electron/runtime.js generates the keys
 * and points at a database beside them, and there is nobody to misconfigure it.
 * A hosted deployment is the opposite: every one of these values is typed into
 * a dashboard by hand, and the ways they go wrong are quiet. A missing APP_URL
 * does not break a page; it emails a customer a link to localhost. A missing
 * ENCRYPTION_KEY does not break sign-in; it stops the business saving the mail
 * password it needs to send anything at all.
 *
 * So the checks live in one place and run at boot, and the fatal ones stop the
 * server rather than letting it serve a broken deployment convincingly.
 */

export type ConfigEnv = Record<string, string | undefined>;

export type ConfigProblem = {
  level: "fatal" | "warning";
  setting: string;
  message: string;
};

/**
 * The address this deployment answers on, used for links that leave the
 * building — a client's "view your invoice" and "pay now".
 *
 * APP_URL wins because it is the only one anybody chose deliberately. On Vercel
 * the production domain is next: a deployment-specific URL would work today and
 * 404 the moment the next deploy replaces it, which is exactly the wrong
 * property for a link sitting in a customer's inbox. That per-deployment URL is
 * used only when there is nothing else, which on a preview build is correct.
 */
export function resolveAppUrl(env: ConfigEnv = process.env): string {
  const explicit = env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const production = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production.replace(/\/$/, "")}`;

  const deployment = env.VERCEL_URL?.trim();
  if (deployment) return `https://${deployment.replace(/\/$/, "")}`;

  return "http://localhost:3000";
}

/** True when the app is serving real traffic rather than a dev server. */
function isProduction(env: ConfigEnv) {
  return env.NODE_ENV === "production";
}

/**
 * Whether the business's records stay on the machine this is running on.
 *
 * True for a desktop install: the database is a SQLite file beside the
 * application and uploads go to a folder on the same disk. False for the hosted
 * deployment, where both live somewhere else entirely.
 *
 * Derived rather than declared, because several screens make this exact claim
 * to a customer in so many words — "everything stays on this computer" is a
 * promise about where their client list goes. A flag set by hand can be wrong
 * about that. This cannot be wrong unless the data really is somewhere else.
 *
 * An unreadable DATABASE_URL counts as hosted. The safe direction to fail is
 * the one that does not make the promise.
 */
export function dataStaysOnThisMachine(env: ConfigEnv = process.env): boolean {
  try {
    return (
      providerFor(env.DATABASE_URL) === "sqlite" &&
      storageProviderId(env) === "local"
    );
  } catch {
    return false;
  }
}

/**
 * Everything wrong with this deployment's configuration.
 *
 * Returns problems rather than throwing so the caller decides what to do with
 * them, and so this is testable without a process to kill.
 */
export function configProblems(env: ConfigEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const production = isProduction(env);

  try {
    providerFor(env.DATABASE_URL);
  } catch (error) {
    problems.push({
      level: "fatal",
      setting: "DATABASE_URL",
      message: (error as Error).message,
    });
  }

  const sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (!sessionSecret) {
    problems.push({
      level: "fatal",
      setting: "SESSION_SECRET",
      message:
        "SESSION_SECRET is not set. Sessions cannot be signed, so nobody can sign in.\n" +
        '  Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    });
  } else if (sessionSecret.length < 32) {
    problems.push({
      level: production ? "fatal" : "warning",
      setting: "SESSION_SECRET",
      message: `SESSION_SECRET is ${sessionSecret.length} characters; use at least 32.`,
    });
  }

  // Not fatal: the app runs without it and the screens that need it say so.
  // Loud, because the business discovers it the day they try to send an invoice.
  const encryptionKey = env.ENCRYPTION_KEY?.trim() ?? "";
  if (encryptionKey.length < 32) {
    problems.push({
      level: "warning",
      setting: "ENCRYPTION_KEY",
      message:
        (encryptionKey ? "ENCRYPTION_KEY is shorter than 32 characters." : "ENCRYPTION_KEY is not set.") +
        "\n  Email and payment credentials cannot be saved until it is." +
        "\n  Once set it must never change: every stored credential is encrypted under it.",
    });
  }

  if (production && resolveAppUrl(env).startsWith("http://localhost")) {
    problems.push({
      level: "warning",
      setting: "APP_URL",
      message:
        "APP_URL is not set and no deployment URL was found, so client-facing\n" +
        "  links will point at localhost. Estimates and invoices would go out\n" +
        "  with an address the recipient cannot open.",
    });
  }

  // Serverless hosts cannot keep a file written to disk. providers.ts refuses
  // this at the first upload; saying so at boot is a great deal cheaper.
  if (env.VERCEL && storageProviderId(env) === "local") {
    problems.push({
      level: "fatal",
      setting: "STORAGE_PROVIDER",
      message:
        "Storage is local disk, but this is Vercel, whose filesystem is read-only\n" +
        "  and per-invocation. Uploads would appear to succeed and be lost.\n" +
        "  Set STORAGE_PROVIDER=s3 or vercel-blob.",
    });
  }

  return problems;
}

/** Formats problems for a log a person has to read, possibly over the phone. */
export function formatProblems(problems: ConfigProblem[]) {
  return problems
    .map((p) => `  [${p.level}] ${p.setting}: ${p.message}`)
    .join("\n");
}
