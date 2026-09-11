import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadHomelab } from "../loader";
import type { LoadedHomelab } from "../loader";
import { validateHomelab, formatValidationIssues } from "../validator";
import { decryptAppSecrets, canDecrypt } from "../secrets";
import { generateComposeFile, serializeComposeFile } from "../generator/compose";

/** Every app name sharing the given `group` value. Throws if none match. */
function resolveGroupAppNames(loaded: LoadedHomelab, group: string): string[] {
  const names = loaded.apps.filter((a) => a.group === group).map((a) => a.name);
  if (names.length === 0) {
    throw new Error(`no apps found with group '${group}'`);
  }
  return names;
}

export interface GroupDeployOptions {
  root: string;
  group: string;
}

/**
 * `homelab group deploy <group>` — same pipeline as `app deploy`, but scoped to every
 * app sharing `group`. Also solves the dependsOn-closure gap for the common case
 * where a dependent and its dependency are declared in the same group (e.g. a
 * server/worker/postgres trio) — deploying the whole group together means every
 * member is included in the same `docker compose up -d` invocation regardless of
 * dependsOn ordering.
 */
export async function groupDeploy({ root, group }: GroupDeployOptions): Promise<void> {
  console.log(`→ loading (scoped to group '${group}')`);
  const loaded = await loadHomelab(root);
  const names = resolveGroupAppNames(loaded, group);

  console.log(`→ validating ${names.length} app(s): ${names.join(", ")}`);
  for (const name of names) {
    const result = await validateHomelab(loaded, {
      onlyApp: name,
      checkSecrets: (envFrom) => canDecrypt(root, envFrom),
    });
    if (!result.ok) {
      console.error(formatValidationIssues(result));
      throw new Error(`deploy aborted: validation failed for '${name}'`);
    }
  }
  console.log("  ✓ validation passed");

  console.log("→ decrypting secrets for all apps (compose needs the full picture)");
  const secretsEnvFiles = new Map<string, string>();
  for (const app of loaded.apps) {
    if (!app.secrets?.envFrom) continue;
    const path = await decryptAppSecrets(root, app);
    if (path) secretsEnvFiles.set(app.name, path);
  }

  console.log("→ regenerating platform/compose/generated-apps.yml");
  const compose = generateComposeFile(root, loaded, secretsEnvFiles);
  const composeDir = join(root, "platform", "compose");
  await mkdir(composeDir, { recursive: true });
  const generatedPath = join(composeDir, "generated-apps.yml");
  await Bun.write(generatedPath, serializeComposeFile(compose));

  console.log(`→ docker compose up -d ${names.join(" ")}`);
  const infraPath = join(composeDir, "infrastructure.yml");
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "up", "-d", ...names],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose up failed with exit code ${exitCode}`);
  }
  console.log(`✓ deployed group '${group}': ${names.join(", ")}`);
}

export interface GroupRestartOptions {
  root: string;
  group: string;
}

/** `homelab group restart <group>` — `docker compose restart` every app in the group at once. */
export async function groupRestart({ root, group }: GroupRestartOptions): Promise<void> {
  const loaded = await loadHomelab(root);
  const names = resolveGroupAppNames(loaded, group);

  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  console.log(`→ docker compose restart ${names.join(" ")}`);
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "restart", ...names],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose restart failed with exit code ${exitCode}`);
  }
}

export interface GroupLogsOptions {
  root: string;
  group: string;
  tail?: number;
  follow?: boolean;
}

/** `homelab group logs <group>` — interleaved `docker compose logs` across the whole group. */
export async function groupLogs({ root, group, tail = 200, follow = true }: GroupLogsOptions): Promise<void> {
  const loaded = await loadHomelab(root);
  const names = resolveGroupAppNames(loaded, group);

  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  const args = ["compose", "-f", infraPath, "-f", generatedPath, "logs", "--tail", String(tail)];
  if (follow) args.push("-f");
  args.push(...names);

  const proc = Bun.spawn(["docker", ...args], { stdout: "inherit", stderr: "inherit", cwd: root });
  await proc.exited;
}
