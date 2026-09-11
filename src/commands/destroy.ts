import { join } from "node:path";

export interface DestroyOptions {
  root: string;
  appName: string;
}

/**
 * `homelab app destroy <name>` — removes the container (stopped + force), but deliberately
 * never touches data/<name>/ — that's a separate, explicit decision for the operator.
 */
export async function destroy({ root, appName }: DestroyOptions): Promise<void> {
  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  console.log(`→ docker compose rm -sf ${appName}`);
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "rm", "-sf", appName],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose rm failed with exit code ${exitCode}`);
  }
  console.log(`✓ destroyed container for ${appName} (data/${appName}/ left untouched)`);
}
