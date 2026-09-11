import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadHomelab } from "../loader";
import { validateHomelab, formatValidationIssues } from "../validator";
import { decryptAppSecrets, canDecrypt } from "../secrets";
import { generateComposeFile, serializeComposeFile } from "../generator/compose";

export interface DeployOptions {
  root: string;
  appName: string;
}

/**
 * `homelab app deploy <name>` — same pipeline as `apply`, but scoped: validates only the
 * named app (against the full set for uniqueness), regenerates the FULL compose file
 * (compose needs the whole picture to resolve shared networks), but only brings up the
 * one named service.
 */
export async function deploy({ root, appName }: DeployOptions): Promise<void> {
  console.log(`→ loading (scoped to '${appName}')`);
  const loaded = await loadHomelab(root);

  if (!loaded.apps.some((a) => a.name === appName)) {
    throw new Error(`app '${appName}' not found under apps/`);
  }

  console.log("→ validating");
  const result = await validateHomelab(loaded, {
    onlyApp: appName,
    checkSecrets: (envFrom) => canDecrypt(root, envFrom),
  });
  if (!result.ok) {
    console.error(formatValidationIssues(result));
    throw new Error("deploy aborted: validation failed");
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

  console.log(`→ docker compose up -d ${appName}`);
  const infraPath = join(composeDir, "infrastructure.yml");
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "up", "-d", appName],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose up failed with exit code ${exitCode}`);
  }
  console.log(`✓ deployed ${appName}`);
}
