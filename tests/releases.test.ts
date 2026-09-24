import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/download/[platform]/route";
import {
  compareVersions,
  fallbackDownload,
  latestInstaller,
  parseManifest,
  pickInstaller,
  releaseTags,
  RELEASES_PAGE,
} from "@/lib/releases";

/**
 * The download buttons.
 *
 * What is worth pinning is not that GitHub answers but what happens when a
 * release is not what the button expects: a Windows-only release, a GitHub that
 * is slow or down, a manifest naming something that is not ours. Each of those
 * has a right answer, and the wrong ones are a dead button, a false "not
 * published", or a redirect somewhere it should never go.
 */

// Shaped like GitHub's real releases.atom, in its own order: by when a release
// was last edited. v0.2.0 is first here the way it would be after an installer
// was backfilled onto it — newest by edit, oldest by version.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link type="text/html" rel="alternate" href="https://github.com/JLMattyice/matlockone/releases"/>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/JLMattyice/matlockone/releases/tag/v0.2.0"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/JLMattyice/matlockone/releases/tag/v0.3.1"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/JLMattyice/matlockone/releases/tag/v0.4.0-beta.1"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/JLMattyice/matlockone/releases/tag/v0.3.0"/>
  </entry>
</feed>`;

// The v0.3.0 manifests as published, hashes shortened.
const WINDOWS_MANIFEST = `version: 0.3.0
files:
  - url: MatlockOne-Setup-0.3.0.exe
    sha512: abc
    size: 153300360
path: MatlockOne-Setup-0.3.0.exe
sha512: abc
releaseDate: '2026-09-20T00:24:40.725Z'
`;

const MAC_MANIFEST = `version: 0.3.0
files:
  - url: MatlockOne-0.3.0-x64.zip
    sha512: abc
    size: 239215917
  - url: MatlockOne-0.3.0-x64.dmg
    sha512: abc
    size: 216375811
path: MatlockOne-0.3.0-x64.zip
sha512: abc
releaseDate: '2026-09-16T10:42:40.407Z'
`;

const windows31 = WINDOWS_MANIFEST.replaceAll("0.3.0", "0.3.1");

type Route = Record<string, { status: number; body?: string } | "throw" | "hang">;

/** A GitHub that answers from a table, recording what it was asked. */
function github(routes: Route) {
  const asked: string[] = [];

  const fetcher = async (url: string) => {
    asked.push(url);
    const route = routes[url];

    if (route === "throw") throw new TypeError("fetch failed");
    if (route === "hang") return new Promise<Response>(() => {});
    if (!route) return new Response("Not Found", { status: 404 });

    return new Response(route.body ?? "", { status: route.status });
  };

  return { fetcher, asked };
}

const feedUrl = `${RELEASES_PAGE}.atom`;
const manifestUrl = (tag: string, file: string) =>
  `${RELEASES_PAGE}/download/${tag}/${file}`;

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3.1", "v0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0);
  });
});

describe("releaseTags", () => {
  it("orders by version rather than by the feed's edit order", () => {
    expect(releaseTags(FEED)).toEqual(["v0.3.1", "v0.3.0", "v0.2.0"]);
  });

  it("leaves pre-releases out", () => {
    // Somebody downloading the app should be handed the finished one.
    expect(releaseTags(FEED)).not.toContain("v0.4.0-beta.1");
  });

  it("finds nothing in something that is not a feed", () => {
    expect(releaseTags("<html>rate limited</html>")).toEqual([]);
  });
});

describe("parseManifest", () => {
  it("reads the version and every file with its size", () => {
    expect(parseManifest(MAC_MANIFEST)).toEqual({
      version: "0.3.0",
      files: [
        { url: "MatlockOne-0.3.0-x64.zip", size: 239215917 },
        { url: "MatlockOne-0.3.0-x64.dmg", size: 216375811 },
      ],
    });
  });

  it("takes a quoted version and Windows line endings", () => {
    const manifest = parseManifest(
      "version: '0.3.1'\r\nfiles:\r\n  - url: MatlockOne-Setup-0.3.1.exe\r\n    size: 10\r\n",
    );
    expect(manifest.version).toBe("0.3.1");
    expect(manifest.files).toEqual([{ url: "MatlockOne-Setup-0.3.1.exe", size: 10 }]);
  });
});

describe("pickInstaller", () => {
  it("hands out the Windows installer", () => {
    const installer = pickInstaller("windows", "v0.3.0", parseManifest(WINDOWS_MANIFEST));

    expect(installer).toMatchObject({
      version: "0.3.0",
      fileName: "MatlockOne-Setup-0.3.0.exe",
      url: `${RELEASES_PAGE}/download/v0.3.0/MatlockOne-Setup-0.3.0.exe`,
      size: 153300360,
    });
  });

  it("hands a Mac the DMG, never the zip the updater uses", () => {
    const installer = pickInstaller("mac", "v0.3.0", parseManifest(MAC_MANIFEST));

    expect(installer?.fileName).toBe("MatlockOne-0.3.0-x64.dmg");
    expect(installer?.arch).toBe("x64");
  });

  it("prefers Apple Silicon when one manifest names both", () => {
    const both = parseManifest(
      "version: 0.3.1\nfiles:\n  - url: MatlockOne-0.3.1-x64.dmg\n  - url: MatlockOne-0.3.1-arm64.dmg\n",
    );
    expect(pickInstaller("mac", "v0.3.1", both)?.arch).toBe("arm64");
  });

  it("refuses a manifest entry that is a path or an address", () => {
    // The route redirects to whatever this returns. It must only ever be able
    // to reach this repository's own release, whatever the manifest says.
    for (const url of [
      "https://evil.example/MatlockOne-Setup.exe",
      "../../other/repo/MatlockOne-Setup.exe",
      "sub/MatlockOne-Setup.exe",
    ]) {
      const manifest = { version: "0.3.1", files: [{ url, size: null }] };
      expect(pickInstaller("windows", "v0.3.1", manifest), url).toBeNull();
    }
  });

  it("finds nothing for a platform the manifest does not cover", () => {
    expect(pickInstaller("mac", "v0.3.0", parseManifest(WINDOWS_MANIFEST))).toBeNull();
  });
});

describe("latestInstaller", () => {
  it("finds the newest release's installer", async () => {
    const { fetcher } = github({
      [feedUrl]: { status: 200, body: FEED },
      [manifestUrl("v0.3.1", "latest.yml")]: { status: 200, body: windows31 },
    });

    const lookup = await latestInstaller("windows", { fetcher });

    expect(lookup).toMatchObject({
      status: "found",
      installer: { version: "0.3.1", tag: "v0.3.1" },
    });
  });

  it("walks back past a release with no build for this platform", async () => {
    // A Windows-only release is normal until the Apple secrets exist. The Mac
    // button should keep offering the last Mac build, not go dark.
    const { fetcher } = github({
      [feedUrl]: { status: 200, body: FEED },
      [manifestUrl("v0.3.0", "latest-mac.yml")]: { status: 200, body: MAC_MANIFEST },
    });

    const lookup = await latestInstaller("mac", { fetcher });

    expect(lookup).toMatchObject({
      status: "found",
      installer: { version: "0.3.0", fileName: "MatlockOne-0.3.0-x64.dmg" },
    });
  });

  it("answers none when no release has one", async () => {
    const { fetcher } = github({ [feedUrl]: { status: 200, body: FEED } });

    expect(await latestInstaller("mac", { fetcher })).toEqual({ status: "none" });
  });

  it("answers unknown, not none, when the feed will not load", async () => {
    // "None" would put up "not published yet" over a build that is published.
    for (const failure of [{ status: 429 }, { status: 503 }, "throw"] as const) {
      const { fetcher } = github({ [feedUrl]: failure });
      expect(await latestInstaller("windows", { fetcher })).toEqual({ status: "unknown" });
    }
  });

  it("stops rather than skipping a release GitHub did not answer for", async () => {
    // Walking past a 503 would offer v0.3.0 while v0.3.1 exists.
    const { fetcher, asked } = github({
      [feedUrl]: { status: 200, body: FEED },
      [manifestUrl("v0.3.1", "latest.yml")]: { status: 503 },
      [manifestUrl("v0.3.0", "latest.yml")]: { status: 200, body: WINDOWS_MANIFEST },
    });

    expect(await latestInstaller("windows", { fetcher })).toEqual({ status: "unknown" });
    expect(asked).not.toContain(manifestUrl("v0.3.0", "latest.yml"));
  });

  it("looks back only a handful of releases", async () => {
    const many = Array.from(
      { length: 12 },
      (_, index) =>
        `<link href="https://github.com/JLMattyice/matlockone/releases/tag/v1.${index}.0"/>`,
    ).join("\n");
    const { fetcher, asked } = github({ [feedUrl]: { status: 200, body: many } });

    await latestInstaller("mac", { fetcher });

    // The feed, then five manifests.
    expect(asked).toHaveLength(6);
  });

  describe("when GitHub is slow", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives up after a few seconds instead of holding the page", async () => {
      const { fetcher } = github({ [feedUrl]: "hang" });

      const pending = latestInstaller("windows", { fetcher });
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await pending).toEqual({ status: "unknown" });
    });
  });
});

describe("the download route", () => {
  const params = (platform: string) => ({ params: Promise.resolve({ platform }) });
  const request = new Request("https://www.matlockone.com/download/windows");

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("redirects to the newest installer, temporarily", async () => {
    vi.stubGlobal(
      "fetch",
      github({
        [feedUrl]: { status: 200, body: FEED },
        [manifestUrl("v0.3.1", "latest.yml")]: { status: 200, body: windows31 },
      }).fetcher,
    );

    const response = await GET(request, params("windows"));

    // Temporary: after the next release this address must lead elsewhere.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${RELEASES_PAGE}/download/v0.3.1/MatlockOne-Setup-0.3.1.exe`,
    );
  });

  it("falls back to the configured address when GitHub is down", async () => {
    vi.stubGlobal("fetch", github({ [feedUrl]: "throw" }).fetcher);
    vi.stubEnv(
      "DOWNLOAD_URL_WINDOWS",
      `${RELEASES_PAGE}/download/v0.3.0/MatlockOne-Setup-0.3.0.exe`,
    );

    const response = await GET(request, params("windows"));

    expect(response.headers.get("location")).toBe(
      `${RELEASES_PAGE}/download/v0.3.0/MatlockOne-Setup-0.3.0.exe`,
    );
  });

  it("falls back to the list of releases when nothing else is known", async () => {
    vi.stubGlobal("fetch", github({ [feedUrl]: "throw" }).fetcher);
    vi.stubEnv("DOWNLOAD_URL_MACOS", "");

    const response = await GET(request, params("mac"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(RELEASES_PAGE);
  });

  it("does not exist for a platform there is no build for", async () => {
    const response = await GET(request, params("linux"));
    expect(response.status).toBe(404);
  });
});

describe("fallbackDownload", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a blank variable as unset", () => {
    vi.stubEnv("DOWNLOAD_URL_WINDOWS", "   ");
    expect(fallbackDownload("windows")).toBeNull();
  });
});
