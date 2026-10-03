/**
 * The push services a device's notification address may point at: Google's
 * (Chrome, Android, Edge on Android), Apple's (Safari, iPhone home-screen
 * apps), Mozilla's (Firefox) and Microsoft's (Edge on Windows).
 *
 * The server sends to whatever address is saved, so anything else is refused
 * rather than trusted because a browser said so.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.apple.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

export function pushServiceAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
