import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import YAML from "yaml";
import { AppManifestSchema, ProfileSchema, type AppManifest, type Profile } from "./schema";

export interface LoadedHomelab {
  root: string;
  apps: AppManifest[];
  profiles: Map<string, Profile>;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).exists();
    return stat;
  } catch {
    return false;
  }
}

/**
 * Loads every apps/<name>/app.yml and platform/profiles/*.yml under `root`.
 * Does NOT validate cross-app rules — see validator.ts for that.
 */
export async function loadHomelab(root: string): Promise<LoadedHomelab> {
  const appsDir = join(root, "apps");
  const profilesDir = join(root, "platform", "profiles");

  const apps: AppManifest[] = [];
  const appFolders = await readdir(appsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of appFolders) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(appsDir, entry.name, "app.yml");
    if (!(await dirExists(manifestPath))) continue;
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = YAML.parse(raw);
    const result = AppManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid app manifest at ${manifestPath}:\n${result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`
      );
    }
    if (result.data.name !== entry.name) {
      throw new Error(
        `App manifest at ${manifestPath} has name '${result.data.name}' but lives in folder '${entry.name}' — they must match`
      );
    }
    apps.push(result.data);
  }

  const profiles = new Map<string, Profile>();
  const profileFiles = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of profileFiles) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
    const profilePath = join(profilesDir, entry.name);
    const raw = await readFile(profilePath, "utf-8");
    const parsed = YAML.parse(raw);
    const result = ProfileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid profile at ${profilePath}:\n${result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`
      );
    }
    const expectedName = basename(entry.name, ".yml");
    if (result.data.name !== expectedName) {
      throw new Error(
        `Profile at ${profilePath} has name '${result.data.name}' but filename implies '${expectedName}' — they must match`
      );
    }
    profiles.set(result.data.name, result.data);
  }

  return { root, apps, profiles };
}

/** Resolve the profile referenced by an app's exposure.type. Throws if missing. */
export function resolveProfile(loaded: LoadedHomelab, profileName: string): Profile {
  const profile = loaded.profiles.get(profileName);
  if (!profile) {
    throw new Error(
      `Profile '${profileName}' not found in platform/profiles/ (available: ${[...loaded.profiles.keys()].join(", ") || "none"})`
    );
  }
  return profile;
}
