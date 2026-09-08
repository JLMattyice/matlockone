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
