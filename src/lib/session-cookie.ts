/**
 * The cookie name lives on its own so `middleware.ts` (Edge runtime) can import
 * it without pulling in `session.ts`, which depends on node:crypto and Prisma.
 */
export const SESSION_COOKIE = "fb_session";
