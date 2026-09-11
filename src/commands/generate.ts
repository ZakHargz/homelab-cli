import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { loadHomelab } from "../loader";
import { validateHomelab, formatValidationIssues } from "../validator";
import { decryptAppSecrets, canDecrypt } from "../secrets";
import { generateComposeFile, serializeComposeFile } from "../generator/compose";
import { diffLines, summarizeDiff } from "../diff";

export interface GenerateOptions {
  root: string;
  appName?: string;
}

/**
 * `homelab app generate [name]` — preview pipeline:
 *   load -> validate -> decrypt secrets -> generate compose -> diff vs existing
 *   generated-apps.yml -> write new generated-apps.yml
 * Deliberately never calls `docker compose up -d`. Scoping matches `validate`:
 * omitted name checks/regenerates everything; a name only narrows validation +
 * which app is highlighted, NOT which services get written (compose still needs
 * the whole picture for shared networks).
 */
export async function generate({ root, appName }: GenerateOptions): Promise<void> {
  console.log(appName ? `→ loading (scoped to '${appName}')` : "→ loading all apps");
  const loaded = await loadHomelab(root);

  if (appName && !loaded.apps.some((a) => a.name === appName)) {
    throw new Error(`app '${appName}' not found under apps/`);
  }

  console.log("→ validating");
  const result = await validateHomelab(loaded, {
    onlyApp: appName,
    checkSecrets: (envFrom) => canDecrypt(root, envFrom),
  });
  if (!result.ok) {
    console.error(formatValidationIssues(result));
    throw new Error("generate aborted: validation failed");
  }
  console.log("  ✓ validation passed");

  console.log("→ decrypting secrets (same as apply/deploy, so the diff is accurate)");
  const secretsEnvFiles = new Map<string, string>();
  for (const app of loaded.apps) {
    if (!app.secrets?.envFrom) continue;
    const path = await decryptAppSecrets(root, app);
    if (path) secretsEnvFiles.set(app.name, path);
  }

  console.log("→ generating compose (in memory)");
  const compose = generateComposeFile(root, loaded, secretsEnvFiles);
  const newYaml = serializeComposeFile(compose);

  const composeDir = join(root, "platform", "compose");
  const generatedPath = join(composeDir, "generated-apps.yml");

  let oldYaml = "";
  try {
    oldYaml = await readFile(generatedPath, "utf8");
  } catch {
    // no previous generated-apps.yml yet — everything shows as "added"
  }

  console.log("\n--- diff vs current generated-apps.yml ---");
  const diff = diffLines(oldYaml, newYaml);
  const changed = diff.some((line) => line.startsWith("+ ") || line.startsWith("- "));
  if (!changed) {
    console.log("(no changes)");
  } else {
    console.log(diff.join("\n"));
    console.log(`\n${summarizeDiff(diff)}`);
  }
  console.log("--- end diff ---\n");

  await mkdir(composeDir, { recursive: true });
  await Bun.write(generatedPath, newYaml);
  console.log(
    `✓ wrote ${generatedPath} (docker compose was NOT run — use 'homelab apply' or 'homelab app deploy <name>' to actually reconcile)`
  );
}
