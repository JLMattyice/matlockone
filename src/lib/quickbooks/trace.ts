import "server-only";

/**
 * Intuit's reference for one request: every response carries it in an
 * `intuit_tid` header, and it is what Intuit's support asks for first. Kept
 * on every failure — in the error a record shows and in the server log —
 * so a problem a business reports can be handed to Intuit as it happened.
 */

export function intuitTid(response: Response): string | null {
  return response.headers.get("intuit_tid")?.trim() || null;
}

/**
 * One line in the server log per refusal from Intuit. What was asked and
 * what came back, never a token or a record's contents.
 */
export function logQuickBooksFailure(details: {
  operation: string;
  status: number;
  code?: string | null;
  message: string;
  tid: string | null;
  organizationId?: string;
}) {
  console.error(
    "[quickbooks]",
    JSON.stringify({
      operation: details.operation,
      organizationId: details.organizationId,
      status: details.status,
      code: details.code ?? undefined,
      intuit_tid: details.tid ?? undefined,
      message: details.message.slice(0, 500),
    }),
  );
}
