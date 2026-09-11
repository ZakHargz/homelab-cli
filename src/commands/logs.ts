import { join } from "node:path";

export interface LogsOptions {
  root: string;
  appName: string;
  follow?: boolean;
  tail?: number;
}

/** `homelab app logs <name>` — streams (or dumps) a service's logs via docker compose. */
export async function logs({ root, appName, follow = true, tail = 200 }: LogsOptions): Promise<void> {
  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  const args = ["docker", "compose", "-f", infraPath, "-f", generatedPath, "logs", "--tail", String(tail)];
  if (follow) args.push("-f");
  args.push(appName);

  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", cwd: root });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose logs failed with exit code ${exitCode}`);
  }
}
