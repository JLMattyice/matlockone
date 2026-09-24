/**
 * The decisions `npm run release` makes, kept apart from the git and npm calls
 * so they can be tested without a repository.
 */

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Negative when a is older than b. */
export function compareVersions(a, b) {
  const left = STABLE.exec(a);
  const right = STABLE.exec(b);
  if (!left || !right) throw new Error(`Not a version: ${!left ? a : b}`);

  for (let part = 1; part <= 3; part++) {
    const difference = Number(left[part]) - Number(right[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The version being released, from what was asked for.
 *
 * `patch`, `minor` or `major` bump the current one; an explicit version is
 * taken as given, as long as it is newer. Anything that would not be newer is
 * refused, because every installed copy decides whether to update by
 * comparing versions — a release numbered at or below the current one is a
 * release nobody receives.
 */
export function nextVersion(current, request) {
  const now = STABLE.exec(current);
  if (!now) throw new Error(`package.json has "${current}", which is not a version this can bump.`);

  const [major, minor, patch] = now.slice(1).map(Number);

  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "major") return `${major + 1}.0.0`;

  if (typeof request === "string" && STABLE.test(request)) {
    const wanted = request.replace(/^v/, "");
    if (compareVersions(wanted, current) <= 0) {
      throw new Error(
        `${wanted} is not newer than ${current}. Installed copies only update to a higher version.`,
      );
    }
    return wanted;
  }

  throw new Error(
    `"${request ?? ""}" is not patch, minor, major or a version like 0.4.0.`,
  );
}

/** The commits worth listing: not merges, not earlier release commits. */
export function changesWorthListing(subjects) {
  return subjects
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => !/^Release \d+\.\d+\.\d+$/.test(subject));
}

/**
 * The release notes, which become the tag's message and then the text on the
 * GitHub release.
 *
 * The one-line summary comes first because it is what a customer reads on
 * the release page. Previous releases carried exactly that and nothing else.
 * The commit list follows for anybody who wants the detail.
 */
export function releaseNotes({ version, previousTag, summary, subjects }) {
  const lines = [];

  if (summary?.trim()) lines.push(summary.trim(), "");

  if (subjects.length > 0) {
    lines.push(previousTag ? `Changes since ${previousTag}:` : "Changes:", "");
    for (const subject of subjects) lines.push(`- ${subject}`);
  } else {
    lines.push(`Matlock One ${version}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * package.json and package-lock.json with the version changed, and nothing
 * else about them — indentation and line endings as they were.
 */
export function withVersion(text, version, { lockfile = false } = {}) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const data = JSON.parse(text);

  data.version = version;
  if (lockfile && data.packages?.[""]) data.packages[""].version = version;

  return JSON.stringify(data, null, 2).replace(/\n/g, eol) + eol;
}

/** owner/repo from an origin URL, for the links printed at the end. */
export function repositoryFrom(remoteUrl) {
  const match = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}
