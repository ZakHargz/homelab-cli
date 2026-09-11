import { join } from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { loadHomelab } from "../loader";

interface ComposePsEntry {
  Name: string;
  State: string;
  Service: string;
}

export interface StatusOptions {
  root: string;
}

/**
 * Reads the service definitions declared in the hand-maintained infrastructure.yml
 * (edge-tunnel, dockflare*, traefik, authentik-*, private-tunnel, ...), including each
 * service's optional `x-group` extension field (a Compose extension field, ignored by
 * Compose itself, used here purely for the same visual banding apps get via their own
 * `group` field). Best-effort: returns [] if the file doesn't exist or fails to parse,
 * rather than failing the whole `status` command over it.
 */
async function loadInfraServices(root: string): Promise<Array<{ name: string; group: string }>> {
  const infraPath = join(root, "platform", "compose", "infrastructure.yml");
  try {
    const raw = await readFile(infraPath, "utf-8");
    const parsed = YAML.parse(raw);
    const services = parsed?.services ?? {};
    return Object.entries(services as Record<string, { "x-group"?: string }>).map(([name, def]) => ({
      name,
      group: def?.["x-group"] ?? "",
    }));
  } catch {
    return [];
  }
}

/** Column widths computed from the actual longest value (header included) + a fixed gap. */
function widthOf(header: string, values: string[]): number {
  const GAP = 2;
  return Math.max(header.length, ...values.map((v) => v.length)) + GAP;
}

/**
 * Band related rows together visually: sort by group first (ungrouped rows last,
 * sorted after every real group), then by name within a group. Purely a display
 * convenience — shared by both the apps table and the infrastructure table.
 */
function sortByGroup<T extends { name: string; group: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.group !== b.group) {
      if (a.group === "") return 1;
      if (b.group === "") return -1;
      return a.group.localeCompare(b.group);
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * `homelab status` — joins `docker compose ps --format json` against apps/<name>/app.yml
 * to render a NAME / STATUS / EXPOSURE / AUTH / GROUP table for generated apps, AND a
 * second NAME / STATUS / GROUP table for hand-maintained infrastructure.yml services
 * (tunnels, Traefik, DockFlare, Authentik, ...) — so the whole homelab's status is
 * visible from one command, not just the generated apps. Infra services opt into
 * banding the same way apps do, via an `x-group` extension field in infrastructure.yml.
 */
export async function status({ root }: StatusOptions): Promise<void> {
  const loaded = await loadHomelab(root);

  const composeDir = join(root, "platform", "compose");
  const infraPath = join(composeDir, "infrastructure.yml");
  const generatedPath = join(composeDir, "generated-apps.yml");

  const proc = Bun.spawn(
    ["docker", "compose", "-f", infraPath, "-f", generatedPath, "ps", "--format", "json"],
    { stdout: "pipe", stderr: "pipe", cwd: root }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const running = new Map<string, string>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    try {
      const entry: ComposePsEntry = JSON.parse(line);
      running.set(entry.Service, entry.State);
    } catch {
      /* docker compose ps returned nothing / non-json line, ignore */
    }
  }

  // --- Apps table (generated from apps/<name>/app.yml) ---
  const appRows = sortByGroup(
    loaded.apps.map((app) => ({
      name: app.name,
      status: running.get(app.name) ?? "not deployed",
      exposure: app.exposure.type,
      auth: app.auth.type,
      group: app.group ?? "",
    }))
  );

  const appNameW = widthOf("NAME", appRows.map((r) => r.name));
  const appStatusW = widthOf("STATUS", appRows.map((r) => r.status));
  const appExposureW = widthOf("EXPOSURE", appRows.map((r) => r.exposure));
  const appAuthW = widthOf("AUTH", appRows.map((r) => r.auth));
  // GROUP is the last column — no trailing padding needed, printed as-is.

  const col = (s: string, w: number) => s.padEnd(w);

  console.log("APPS");
  console.log(
    col("NAME", appNameW) + col("STATUS", appStatusW) + col("EXPOSURE", appExposureW) + col("AUTH", appAuthW) + "GROUP"
  );
  for (const row of appRows) {
    console.log(
      col(row.name, appNameW) + col(row.status, appStatusW) + col(row.exposure, appExposureW) + col(row.auth, appAuthW) + row.group
    );
  }

  // --- Infrastructure table (hand-maintained infrastructure.yml) ---
  // No exposure/auth here — that's app.yml metadata Docker/infrastructure.yml has no
  // concept of. GROUP comes from each service's optional `x-group` extension field.
  // Declared services are always listed, even if not currently running, same as apps
  // show "not deployed" — this reflects intent, not just whatever docker compose ps
  // happens to return right now.
  const infraServices = await loadInfraServices(root);
  const infraRows = sortByGroup(
    infraServices.map((svc) => ({
      name: svc.name,
      status: running.get(svc.name) ?? "not deployed",
      group: svc.group,
    }))
  );

  const infraNameW = widthOf("NAME", infraRows.map((r) => r.name));
  const infraStatusW = widthOf("STATUS", infraRows.map((r) => r.status));

  console.log("");
  console.log("INFRASTRUCTURE (hand-maintained, platform/compose/infrastructure.yml)");
  console.log(col("NAME", infraNameW) + col("STATUS", infraStatusW) + "GROUP");
  for (const row of infraRows) {
    console.log(col(row.name, infraNameW) + col(row.status, infraStatusW) + row.group);
  }
}
