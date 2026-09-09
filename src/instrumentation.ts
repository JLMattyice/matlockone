/**
 * Checks the deployment's configuration once, at boot.
 *
 * A hosted deployment is configured by hand in a dashboard, and its
 * misconfigurations are quiet ones: the server starts, pages render, and the
 * damage shows up later as an invoice emailed with a localhost link or a
 * mailbox that cannot be saved. Failing at boot turns a support call weeks
 * later into a deployment that plainly refused to start.
 *
 * Node runtime only. The Edge runtime runs middleware, which reads a cookie and
 * touches none of this.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configProblems, formatProblems } = await import("./lib/config");

  const problems = configProblems();
  if (problems.length === 0) return;

  const fatal = problems.filter((problem) => problem.level === "fatal");
  const warnings = problems.filter((problem) => problem.level === "warning");

  if (warnings.length > 0) {
    console.warn(
      [
        "",
        "=== Matlock One: configuration warnings ===",
        formatProblems(warnings),
        "",
      ].join("\n"),
    );
  }

  if (fatal.length > 0) {
    // Thrown rather than logged: a deployment missing these serves a broken
    // product convincingly, which is worse than one that did not come up.
    throw new Error(
      [
        "Matlock One cannot start with this configuration:",
        formatProblems(fatal),
        "",
      ].join("\n"),
    );
  }
}

/**
 * Makes a production error readable.
 *
 * In a production build Next.js shows the user "a server-side exception has
 * occurred" and a digest, and deliberately says no more — the detail could leak
 * internals to whoever is looking at the screen. That is right for the browser
 * and useless for the person trying to fix it: on the desktop build the server
 * log is the only place to look, and a digest with nothing to match it against
 * is a dead end.
 *
 * onRequestError runs for every uncaught server error, so the log gets the
 * digest *and* the stack that produced it. Matching the two takes one search.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
) {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest)
      : "none";

  const stack =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  // One block, clearly delimited, because this lands in a log the customer may
  // be reading over the phone.
  console.error(
    [
      "",
      `=== server error  digest ${digest}  ${new Date().toISOString()} ===`,
      `  ${request.method ?? "?"} ${request.path ?? "?"}`,
      `  route: ${context.routePath ?? "?"} (${context.routerKind ?? "?"}${
        context.renderSource ? `, ${context.renderSource}` : ""
      })`,
      stack
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      "=== end server error ===",
      "",
    ].join("\n"),
  );
}
