import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadHomelab } from "../loader";
import { validateHomelab, formatValidationIssues } from "../validator";
import { decryptAppSecrets, canDecrypt } from "../secrets";
import { generateComposeFile, serializeComposeFile } from "../generator/compose";

export interface ApplyOptions {
  root: string;
}

/**
 * Full `homelab apply` pipeline:
 *   load -> validate -> decrypt secrets -> generate compose -> docker compose up -d
 * Stateless: always fully regenerates generated-apps.yml. Aborts before any docker
 * command runs if validation fails.
 */
export async function apply({ root }: ApplyOptions): Promise<void> {
  console.log("→ loading apps/<name>/app.yml and platform/profiles/*.yml");
  const loaded = await loadHomelab(root);

  console.log("→ validating");
  const result = await validateHomelab(loaded, {
    checkSecrets: (envFrom) => canDecrypt(root, envFrom),
  });
  if (!result.ok) {
    console.error(formatValidationIssues(result));
    throw new Error("apply aborted: validation failed");
  }
  console.log("  ✓ validation passed");

  console.log("→ decrypting secrets");
  const secretsEnvFiles = new Map<string, string>();
  for (const app of loaded.apps) {
    if (!app.secrets?.envFrom) continue;
    const path = await decryptAppSecrets(root, app);
    if (path) secretsEnvFiles.set(app.name, path);
  }
  console.log(`  ✓ decrypted secrets for ${secretsEnvFiles.size} app(s)`);

  console.log("→ generating platform/compose/generated-apps.yml");
  const compose = generateComposeFile(root, loaded, secretsEnvFiles);
  const composeDir = join(root, "platform", "compose");
  await mkdir(composeDir, { recursive: true });
  const generatedPath = join(composeDir, "generated-apps.yml");
  await Bun.write(generatedPath, serializeComposeFile(compose));
  console.log(`  ✓ wrote ${generatedPath}`);

  console.log("→ docker compose up -d --remove-orphans");
  const infraPath = join(composeDir, "infrastructure.yml");
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "up", "-d", "--remove-orphans"],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose up failed with exit code ${exitCode}`);
  }
  console.log("✓ apply complete");
}
