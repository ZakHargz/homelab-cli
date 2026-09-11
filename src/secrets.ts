import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppManifest } from "./schema";

/**
 * Decrypts a SOPS-encrypted secrets file (referenced by app.secrets.envFrom, relative to root)
 * into platform/state/secrets/<app>.env using the `sops` CLI. Requires SOPS_AGE_KEY_FILE (or an
 * equivalent age identity) to be available in the environment.
 */
export async function decryptAppSecrets(root: string, app: AppManifest): Promise<string | null> {
  if (!app.secrets?.envFrom) return null;

  const encPath = join(root, app.secrets.envFrom);
  const stateDir = join(root, "platform", "state", "secrets");
  await mkdir(stateDir, { recursive: true });
  const outPath = join(stateDir, `${app.name}.env`);

  const proc = Bun.spawn(
    ["sops", "--decrypt", "--output-type", "dotenv", encPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`sops decrypt failed for ${encPath} (exit ${exitCode}):\n${stderr}`);
  }

  await Bun.write(outPath, stdout);
  // Best-effort tighten permissions; not fatal on platforms where chmod semantics differ.
  try {
    await Bun.spawn(["chmod", "600", outPath]).exited;
  } catch {
    /* ignore */
  }

  return outPath;
}

/**
 * Cheap existence+decrypt check used by the validator (does not need the resulting .env
 * to be kept — just confirms the file exists and sops can decrypt it).
 */
export async function canDecrypt(root: string, envFromPath: string): Promise<boolean> {
  const encPath = join(root, envFromPath);
  if (!(await Bun.file(encPath).exists())) return false;

  const proc = Bun.spawn(["sops", "--decrypt", "--output-type", "dotenv", encPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
