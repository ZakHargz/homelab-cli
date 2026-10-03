import YAML from "yaml";

/**
 * Pure helpers for `homelab group release`: deciding which image tags belong to a
 * release, and rewriting them in an app.yml without disturbing anything else in it.
 */

/** A full git commit SHA, as CI tags images with (`${{ github.sha }}`). */
const SHA_RE = /^[0-9a-f]{40}$/;
/** `<sha>` or `<prefix>-<sha>` (e.g. `installer-<sha>` for a migration image). */
const RELEASE_TAG_RE = /^(?:(.+)-)?([0-9a-f]{40})$/;

export function isSha(value: string): boolean {
  return SHA_RE.test(value);
}

/**
 * Splits a release-shaped tag into its prefix and SHA. Returns null for anything else
 * ("17-alpine", "v1.2.3", "latest"), which is how apps that are NOT part of a release
 * (databases, ollama...) are left alone.
 */
export function parseReleaseTag(tag: string): { prefix: string; sha: string } | null {
  const match = RELEASE_TAG_RE.exec(tag);
  if (!match) return null;
  return { prefix: match[1] ? `${match[1]}-` : "", sha: match[2]! };
}

/** The tag this app should move to for `sha`, keeping its prefix; null when it isn't release-shaped. */
export function nextTag(currentTag: string, sha: string): string | null {
  const parsed = parseReleaseTag(currentTag);
  return parsed ? `${parsed.prefix}${sha}` : null;
}

/**
 * Rewrites `image.tag` in an app.yml by replacing ONLY that scalar's text in the
 * source. Nothing is re-serialised, so comments, spacing, quoting and key order stay
 * byte-for-byte as written and the git diff is exactly the one tag line.
 */
export function rewriteImageTag(yamlSource: string, newTag: string): string {
  const doc = YAML.parseDocument(yamlSource);
  const node = doc.getIn(["image", "tag"], true);
  if (!YAML.isScalar(node) || !node.range) {
    throw new Error("app.yml has no image.tag to rewrite");
  }
  const [start, end] = node.range;
  const quote = yamlSource[start] === '"' || yamlSource[start] === "'" ? yamlSource[start] : "";
  return yamlSource.slice(0, start) + quote + newTag + quote + yamlSource.slice(end);
}

export interface ReleaseTarget {
  app: string;
  repository: string;
  from: string;
  to: string;
}

/**
 * Which apps in a group move to `sha`, and to what tag. Apps whose tag is not
 * release-shaped, or whose repository doesn't match `repository` when given, are
 * skipped.
 */
export function planRelease(
  apps: Array<{ name: string; image: { repository: string; tag: string } }>,
  sha: string,
  repository?: string
): ReleaseTarget[] {
  const targets: ReleaseTarget[] = [];
  for (const app of apps) {
    if (repository && app.image.repository !== repository) continue;
    const to = nextTag(app.image.tag, sha);
    if (to) targets.push({ app: app.name, repository: app.image.repository, from: app.image.tag, to });
  }
  return targets;
}
