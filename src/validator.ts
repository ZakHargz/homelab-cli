import type { LoadedHomelab } from "./loader";

export interface ValidationIssue {
  app?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * DFS-based cycle detection over the full dependsOn graph. Returns the cycle as an
 * ordered list of app names (A -> B -> A) if one exists, otherwise null.
 */
function findDependencyCycle(loaded: LoadedHomelab): string[] | null {
  const graph = new Map(loaded.apps.map((a) => [a.name, a.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(name: string): string[] | null {
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name];
    if (visited.has(name)) return null;
    visiting.add(name);
    path.push(name);
    for (const dep of graph.get(name) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = dfs(name);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Cross-app validation rules that require the full set of loaded apps/profiles.
 * Per-app schema validation already happened in loader.ts (AppManifestSchema.safeParse).
 * Optionally scope to a single app name (still loads/checks against the full set for
 * uniqueness/graph rules — hostname collisions and dependsOn cycles can't be checked
 * by looking at one app alone).
 */
export async function validateHomelab(
  loaded: LoadedHomelab,
  opts: { onlyApp?: string; checkSecrets?: (envFromPath: string) => Promise<boolean> } = {}
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const apps = opts.onlyApp ? loaded.apps.filter((a) => a.name === opts.onlyApp) : loaded.apps;

  if (opts.onlyApp && apps.length === 0) {
    return { ok: false, issues: [{ message: `App '${opts.onlyApp}' not found under apps/` }] };
  }

  // Hostname uniqueness (checked against the FULL app set, not just the scoped one)
  const hostnameOwners = new Map<string, string>();
  for (const app of loaded.apps) {
    if (!app.exposure.hostname) continue;
    const existing = hostnameOwners.get(app.exposure.hostname);
    if (existing && existing !== app.name) {
      issues.push({
        app: app.name,
        message: `hostname '${app.exposure.hostname}' is also claimed by app '${existing}'`,
      });
    } else {
      hostnameOwners.set(app.exposure.hostname, app.name);
    }
  }

  // Name uniqueness (folder name already enforces this in loader, but double-check across full set)
  const seenNames = new Set<string>();
  for (const app of loaded.apps) {
    if (seenNames.has(app.name)) {
      issues.push({ app: app.name, message: `duplicate app name '${app.name}'` });
    }
    seenNames.add(app.name);
  }

  // dependsOn: unknown-dependency check (full set — a dependency can be declared by
  // an app outside the --onlyApp scope but still needs to resolve to a real app)
  for (const app of loaded.apps) {
    for (const dep of app.dependsOn) {
      if (!loaded.apps.some((a) => a.name === dep)) {
        issues.push({
          app: app.name,
          message: `dependsOn references unknown app '${dep}'`,
        });
      }
    }
  }

  // dependsOn: circular-dependency check (full graph, regardless of --onlyApp)
  const cycle = findDependencyCycle(loaded);
  if (cycle) {
    issues.push({ message: `circular dependency: ${cycle.join(" -> ")}` });
  }

  for (const app of apps) {
    // exposure.type / auth.type must resolve to a real profile file — EXCEPT
    // "internal", which deliberately has no platform/profiles/internal.yml (it opts
    // out of the profile/routing system entirely).
    if (app.exposure.type !== "internal" && !loaded.profiles.has(app.exposure.type)) {
      issues.push({
        app: app.name,
        message: `exposure.type '${app.exposure.type}' has no matching platform/profiles/${app.exposure.type}.yml`,
      });
    }

    // storage[].name unique within this app
    const storageNames = new Set<string>();
    for (const s of app.storage) {
      if (storageNames.has(s.name)) {
        issues.push({ app: app.name, message: `duplicate storage.name '${s.name}' within app` });
      }
      storageNames.add(s.name);
    }

    // secrets.envFrom must exist and decrypt cleanly, if a checker was supplied
    if (app.secrets?.envFrom && opts.checkSecrets) {
      const ok = await opts.checkSecrets(app.secrets.envFrom);
      if (!ok) {
        issues.push({
          app: app.name,
          message: `secrets.envFrom '${app.secrets.envFrom}' does not exist or failed to decrypt`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function formatValidationIssues(result: ValidationResult): string {
  if (result.ok) return "✓ all checks passed";
  return result.issues
    .map((i) => `✗ ${i.app ? `[${i.app}] ` : ""}${i.message}`)
    .join("\n");
}
