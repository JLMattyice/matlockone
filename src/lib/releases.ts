import "server-only";

/**
 * Where the newest installer for each platform is.
 *
 * The download buttons used to name one exact file through DOWNLOAD_URL_WINDOWS
 * and DOWNLOAD_URL_MACOS, so every release needed a second, separate act on the
 * hosted deployment before a new visitor could get it. Forgetting that act did
 * not break anything visibly: a visitor installed the old version and was
 * offered an update a minute after first launch, which is a poor first minute.
 *
 * Found the way an installed copy finds its updates rather than through
 * GitHub's REST API. The API allows sixty unauthenticated requests an hour per
 * address, and a serverless host shares its outbound addresses with every other
 * tenant on it — so the quota can be spent by strangers before this asks. The
 * releases feed and the release downloads are ordinary github.com pages, which
 * is also why electron-updater uses them.
 *
 * Two files do the work. `releases.atom` lists published releases (never
 * drafts), and each release carries the update manifest electron-builder wrote
 * for it — `latest.yml` for Windows, `latest-mac.yml` for macOS — naming the
 * exact installer. A release without a platform's manifest has no build for it,
 * which is normal here: until the Apple signing secrets exist, a release can be
 * Windows only. So the answer is the newest release that has one, not simply
 * the newest release.
 */

export const RELEASE_REPOSITORY = "JLMattyice/matlockone";

export const RELEASES_PAGE = `https://github.com/${RELEASE_REPOSITORY}/releases`;

export type Platform = "windows" | "mac";

export const PLATFORMS: readonly Platform[] = ["windows", "mac"];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export type Installer = {
  platform: Platform;
  version: string;
  tag: string;
  fileName: string;
  url: string;
  size: number | null;
  /** Read from the file name, which is how electron-builder records it. */
  arch: "arm64" | "x64" | null;
};

/**
 * What the lookup concluded.
 *
 * "none" and "unknown" are kept apart because they call for opposite things.
 * "none" is an answer — GitHub was asked and has no build for this platform —
 * so the download page shows its placeholder. "unknown" means GitHub could not
 * be asked, and turning a working button into "not published yet" because
 * github.com was slow for a moment would be telling visitors something false.
 */
export type InstallerLookup =
  | { status: "found"; installer: Installer }
  | { status: "none" }
  | { status: "unknown" };

const MANIFEST: Record<Platform, string> = {
  windows: "latest.yml",
  mac: "latest-mac.yml",
};

/**
 * How long a lookup is reused. A published release reaches the buttons within
 * this long, and the site asks GitHub at most once per this long per file.
 */
export const LOOKUP_SECONDS = 300;

/** Releases past this many back are not worth walking for an installer. */
const RELEASES_TO_SEARCH = 5;

// ------------------------------------------------------------------ parsing ---

/** Stable versions only: a pre-release is not what a visitor should be given. */
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Negative when a is older than b. Tags without a stable version sort first. */
export function compareVersions(a: string, b: string): number {
  const left = STABLE_TAG.exec(a);
  const right = STABLE_TAG.exec(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;

  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Published release tags from the releases feed, newest version first.
 *
 * Ordered by version rather than by the feed's own order, which follows when a
 * release was last edited — so backfilling an installer onto an old release
 * would otherwise make it look like the newest.
 */
export function releaseTags(atom: string): string[] {
  const tags = new Set<string>();

  for (const match of atom.matchAll(/\/releases\/tag\/([^"<>\s]+)/g)) {
    try {
      tags.add(decodeURIComponent(match[1]));
    } catch {
      // A malformed escape is not a release anybody can download.
    }
  }

  return [...tags]
    .filter((tag) => STABLE_TAG.test(tag))
    .sort((a, b) => compareVersions(b, a));
}

export type Manifest = {
  version: string | null;
  files: { url: string; size: number | null }[];
};

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * The two fields of an electron-builder update manifest this needs.
 *
 * Read line by line rather than with a YAML library: the format is
 * electron-builder's own and fixed, the site has no YAML dependency, and this
 * is the only thing that would need one.
 */
export function parseManifest(text: string): Manifest {
  let version: string | null = null;
  const files: Manifest["files"] = [];

  for (const line of text.split(/\r?\n/)) {
    const top = /^version:\s*(.+?)\s*$/.exec(line);
    if (top) {
      version = unquote(top[1]);
      continue;
    }

    const url = /^\s+-\s+url:\s*(.+?)\s*$/.exec(line);
    if (url) {
      files.push({ url: unquote(url[1]), size: null });
      continue;
    }

    const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (size && files.length > 0) files[files.length - 1].size = Number(size[1]);
  }

  return { version, files };
}

/**
 * A bare file name, as electron-builder writes into the manifest.
 *
 * Anything else — a path, or a whole address — is refused rather than
 * followed. The download route redirects to whatever this produces, and it
 * should only ever be able to send somebody to this repository's own release.
 */
const BARE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

function archOf(fileName: string): Installer["arch"] {
  if (/arm64/i.test(fileName)) return "arm64";
  if (/x64/i.test(fileName)) return "x64";
  return null;
}

/** The installer a person downloads, from one release's manifest. */
export function pickInstaller(
  platform: Platform,
  tag: string,
  manifest: Manifest,
): Installer | null {
  // The DMG, not the zip: the zip is what an installed Mac copy updates itself
  // from, and is not something to hand a person.
  const extension = platform === "windows" ? ".exe" : ".dmg";

  const candidates = manifest.files.filter(
    (file) =>
      file.url.toLowerCase().endsWith(extension) && BARE_FILE_NAME.test(file.url),
  );
  if (candidates.length === 0) return null;

  // One manifest normally names one architecture. If it ever names both,
  // Apple Silicon is what nearly every Mac sold since 2020 is.
  const file =
    candidates.find((candidate) => archOf(candidate.url) === "arm64") ??
    candidates[0];

  return {
    platform,
    version: manifest.version ?? tag.replace(/^v/, ""),
    tag,
    fileName: file.url,
    url: `${RELEASES_PAGE}/download/${encodeURIComponent(tag)}/${encodeURIComponent(file.url)}`,
    size: file.size,
    arch: archOf(file.url),
  };
}

// ------------------------------------------------------------------- lookup ---

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

type LookupOptions = {
  /** Replaced in tests. Next's fetch otherwise, which honours `next.revalidate`. */
  fetcher?: Fetcher;
};

/**
 * Longest the homepage waits on GitHub before rendering without an answer.
 *
 * Raced rather than passed to fetch as an abort signal, so a slow request is
 * not cancelled: it finishes in the background and fills the cache for the
 * next visitor, while this one gets a page now.
 */
const WAIT_MS = 3_000;

async function get(fetcher: Fetcher, url: string): Promise<Response | null> {
  const request = fetcher(url, {
    next: { revalidate: LOOKUP_SECONDS },
  } as RequestInit).catch(() => null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WAIT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The newest published installer for a platform, or why there is not one. */
export async function latestInstaller(
  platform: Platform,
  { fetcher = fetch }: LookupOptions = {},
): Promise<InstallerLookup> {
  const feed = await get(fetcher, `${RELEASES_PAGE}.atom`);
  if (!feed?.ok) return { status: "unknown" };

  const tags = releaseTags(await feed.text()).slice(0, RELEASES_TO_SEARCH);

  for (const tag of tags) {
    const response = await get(
      fetcher,
      `${RELEASES_PAGE}/download/${encodeURIComponent(tag)}/${MANIFEST[platform]}`,
    );

    // A 404 is an answer: this release has no build for this platform, so
    // look at the one before it. Anything else is GitHub not answering, and
    // guessing past it could offer an older installer than the real newest.
    if (!response) return { status: "unknown" };
    if (response.status === 404) continue;
    if (!response.ok) return { status: "unknown" };

    const installer = pickInstaller(platform, tag, parseManifest(await response.text()));
    if (installer) return { status: "found", installer };
  }

  return { status: "none" };
}

/**
 * Where a download button sends somebody when the lookup could not reach
 * GitHub. The old per-release variable still works as that fallback, so a
 * hosted deployment that already has one set keeps working without anybody
 * touching it — it just stops being the thing that has to change each release.
 */
export function fallbackDownload(platform: Platform): string | null {
  const configured =
    platform === "windows"
      ? process.env.DOWNLOAD_URL_WINDOWS
      : process.env.DOWNLOAD_URL_MACOS;
  return configured?.trim() || null;
}
