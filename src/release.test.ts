import { describe, expect, test } from "bun:test";
import { isSha, nextTag, parseReleaseTag, planRelease, rewriteImageTag } from "./release";

const OLD = "c9f75c3842689078b980d524ce9464849dc7463c";
const NEW = "e2fecce0123456789abcdef0123456789abcdef0";

describe("release tags", () => {
  test("recognises plain and prefixed SHA tags, ignores everything else", () => {
    expect(parseReleaseTag(OLD)).toEqual({ prefix: "", sha: OLD });
    expect(parseReleaseTag(`installer-${OLD}`)).toEqual({ prefix: "installer-", sha: OLD });
    for (const tag of ["17-alpine", "latest", "v1.2.3", "installer", "abc1234", `${OLD}0`]) {
      expect(parseReleaseTag(tag)).toBeNull();
    }
  });

  test("keeps the prefix when moving to a new SHA", () => {
    expect(nextTag(OLD, NEW)).toBe(NEW);
    expect(nextTag(`installer-${OLD}`, NEW)).toBe(`installer-${NEW}`);
    expect(nextTag("17-alpine", NEW)).toBeNull();
  });

  test("only full 40-character SHAs are accepted as input", () => {
    expect(isSha(NEW)).toBe(true);
    expect(isSha("e2fecce")).toBe(false);
    expect(isSha(NEW.toUpperCase())).toBe(false);
  });
});

describe("planRelease", () => {
  const apps = [
    { name: "aura-dev", image: { repository: "ghcr.io/me/aura-dev", tag: OLD } },
    { name: "aura-dev-migrate", image: { repository: "ghcr.io/me/aura-dev", tag: `installer-${OLD}` } },
    { name: "aura-dev-postgres", image: { repository: "postgres", tag: "17-alpine" } },
    { name: "aura-dev-ollama", image: { repository: "ollama/ollama", tag: "0.5.4" } },
  ];

  test("moves the app and its migrate job, leaves databases alone", () => {
    expect(planRelease(apps, NEW).map((t) => [t.app, t.to])).toEqual([
      ["aura-dev", NEW],
      ["aura-dev-migrate", `installer-${NEW}`],
    ]);
  });

  test("can be limited to one image repository", () => {
    expect(planRelease(apps, NEW, "ghcr.io/other/app")).toEqual([]);
  });
});

describe("rewriteImageTag", () => {
  const source = `name: aura-dev-migrate

image:
  repository: ghcr.io/me/aura-dev
  tag: installer-${OLD}

# command: ["npx", "prisma", "migrate", "deploy"]
command: ["sh", "-c", "cd packages/db && npx prisma migrate deploy"]
restart: "no"
`;

  test("changes only the tag and keeps comments and formatting", () => {
    const out = rewriteImageTag(source, `installer-${NEW}`);
    expect(out).toBe(source.replace(OLD, NEW));
    expect(out).toContain('# command: ["npx", "prisma", "migrate", "deploy"]');
  });

  test("keeps a quoted tag quoted and leaves other files' quirks alone", () => {
    const quoted = `image:\n  repository: x\n  tag: "${OLD}"   # pinned\nlabels: { a: b }\n`;
    expect(rewriteImageTag(quoted, NEW)).toBe(quoted.replace(OLD, NEW));
  });

  test("refuses a manifest without an image tag", () => {
    expect(() => rewriteImageTag("name: x\n", NEW)).toThrow(/no image.tag/);
  });
});
