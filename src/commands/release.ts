import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadHomelab } from "../loader";
import { groupDeploy } from "./group";
import { isSha, parseReleaseTag, planRelease, rewriteImageTag, type ReleaseTarget } from "../release";

export interface ReleaseOptions {
  root: string;
  group: string;
  /** Full 40-char commit SHA to release. Mutually exclusive with `latest` / `previous`. */
  sha?: string;
  /** Release whatever commit the `latest` image of the group's release repository was built from. */
  latest?: boolean;
  /** Go back to the tags that were running before the last release. */
  previous?: boolean;
  /** Only touch apps using this image repository (default: every release-shaped app in the group). */
  repository?: string;
  dryRun?: boolean;
}

interface ReleaseState {
  /** app name -> the tag it had before the most recent release. */
  previous: Record<string, string>;
  releasedAt: string;
}

function statePath(root: string, group: string): string {
  return join(root, "platform", "state", "releases", `${group}.json`);
}

function manifestPath(root: string, app: string): string {
  return join(root, "apps", app, "app.yml");
}

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Resolves the commit the `latest` image was built from. CI stamps every image with the
 * standard `org.opencontainers.image.revision` label, so no registry credentials or tag
 * listing are needed beyond what `docker pull` already has on the host.
 */
async function resolveLatestSha(repository: string): Promise<string> {
  const image = `${repository}:latest`;
  console.log(`→ docker pull ${image}`);
  const pull = await run(["docker", "pull", "--quiet", image]);
  if (pull.code !== 0) throw new Error(`could not pull ${image}: ${pull.stderr}`);

  const inspect = await run([
    "docker", "image", "inspect", image,
    "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  ]);
  const sha = inspect.stdout;
  if (inspect.code !== 0 || !isSha(sha)) {
    throw new Error(
      `${image} has no usable 'org.opencontainers.image.revision' label (got '${sha}'). ` +
        `Add 'labels: org.opencontainers.image.revision=\${{ github.sha }}' to the CI build, or pass the SHA explicitly.`
    );
  }
  return sha;
}

/**
 * `homelab group release <group> <sha>` — point every release-shaped image tag in the
 * group at one commit, then deploy the group. Rewrites app.yml files in place (comments
 * preserved), records the previous tags for `--previous`, and puts the manifests back if
 * the deploy fails, so they always describe what is actually running.
 *
 * Ordering (migrate before app) is NOT done here: it comes from `dependsOn` with
 * `condition: completed_successfully` on the app, which compose enforces.
 */
export async function groupRelease(opts: ReleaseOptions): Promise<void> {
  const { root, group } = opts;
  const modes = [opts.sha, opts.latest, opts.previous].filter(Boolean).length;
  if (modes !== 1) throw new Error("pass exactly one of: <sha>, --latest, --previous");

  const loaded = await loadHomelab(root);
  const members = loaded.apps.filter((a) => a.group === group);
  if (members.length === 0) throw new Error(`no apps found with group '${group}'`);

  let targets: ReleaseTarget[];

  if (opts.previous) {
    const raw = await readFile(statePath(root, group), "utf-8").catch(() => null);
    if (!raw) throw new Error(`no previous release recorded for group '${group}'`);
    const state = JSON.parse(raw) as ReleaseState;
    targets = members
      .filter((a) => state.previous[a.name] && state.previous[a.name] !== a.image.tag)
      .map((a) => ({ app: a.name, repository: a.image.repository, from: a.image.tag, to: state.previous[a.name]! }));
    if (targets.length === 0) throw new Error("the previous release is already the one running");
  } else {
    let sha = opts.sha;
    if (opts.latest) {
      const candidate = planRelease(members, "0".repeat(40), opts.repository)[0];
      if (!candidate) throw new Error(`group '${group}' has no release-shaped image tags to follow`);
      sha = await resolveLatestSha(candidate.repository);
    }
    if (!sha || !isSha(sha)) throw new Error(`'${sha}' is not a full 40-character commit SHA`);
    targets = planRelease(members, sha, opts.repository);
    if (targets.length === 0) {
      throw new Error(`no apps in group '${group}' have release-shaped image tags (<sha> or <prefix>-<sha>)`);
    }
  }

  console.log(`→ release plan for group '${group}'`);
  for (const t of targets) {
    const same = t.from === t.to;
    const short = (tag: string) => {
      const p = parseReleaseTag(tag);
      return p ? `${p.prefix}${p.sha.slice(0, 7)}` : tag;
    };
    console.log(`  ${t.app}: ${short(t.from)} ${same ? "(unchanged)" : `→ ${short(t.to)}`}`);
  }
  if (opts.dryRun) {
    console.log("(dry run: nothing written, nothing deployed)");
    return;
  }

  const originals = new Map<string, string>();
  for (const t of targets) {
    originals.set(t.app, await readFile(manifestPath(root, t.app), "utf-8"));
  }

  const changed = targets.filter((t) => t.from !== t.to);
  try {
    for (const t of changed) {
      await writeFile(manifestPath(root, t.app), rewriteImageTag(originals.get(t.app)!, t.to));
    }
    await groupDeploy({ root, group });
  } catch (err) {
    for (const t of changed) await writeFile(manifestPath(root, t.app), originals.get(t.app)!);
    console.error("✗ release failed; app.yml tags put back to what they were");
    console.error("  (a failed migration leaves the running app untouched)");
    throw err;
  }

  if (!opts.previous && changed.length > 0) {
    const state: ReleaseState = {
      previous: Object.fromEntries(changed.map((t) => [t.app, t.from])),
      releasedAt: new Date().toISOString(),
    };
    const path = statePath(root, group);
    await mkdir(join(root, "platform", "state", "releases"), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2) + "\n");
  }
  console.log(`✓ released group '${group}'`);
}
