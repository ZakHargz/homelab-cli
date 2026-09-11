import { join } from "node:path";

export interface RestartOptions {
  root: string;
  appName: string;
}

/** `homelab app restart <name>` — restarts an already-running service, no regeneration. */
export async function restart({ root, appName }: RestartOptions): Promise<void> {
  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  console.log(`→ docker compose restart ${appName}`);
  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "restart", appName],
    { stdout: "inherit", stderr: "inherit", cwd: root }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose restart failed with exit code ${exitCode}`);
  }
  console.log(`✓ restarted ${appName}`);
}
