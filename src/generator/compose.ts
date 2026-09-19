import { join, relative } from "node:path";
import YAML from "yaml";
import type { AppManifest } from "../schema";
import { AUTH_MIDDLEWARE_MAP, dependsOnName, dependsOnCondition } from "../schema";
import type { LoadedHomelab } from "../loader";
import { resolveProfile } from "../loader";

interface ComposeService {
  container_name: string;
  image: string;
  command?: string | string[];
  entrypoint?: string | string[];
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  networks?: string[];
  labels?: Record<string, string | boolean>;
  restart?: string;
  security_opt?: string[];
  cap_add?: string[];
  cap_drop?: string[];
  read_only?: boolean;
  depends_on?: string[] | Record<string, { condition: string }>;
  healthcheck?: {
    test: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
}

interface ComposeFile {
  name: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { external: boolean } | { name: string } | null>;
}

/**
 * Name of the dedicated, isolated network auto-created for a given "internal"-typed
 * app (e.g. a per-app docker-socket-proxy -> "net-docker-socket-proxy"). Never shared
 * with a profile-driven tier network — only apps that declare a dependsOn on this app
 * get attached to it. Docker bridge networks have no per-peer ACLs, so isolation has
 * to come from each "internal" app getting its own network rather than sharing a tier
 * network with every other app.
 */
function internalNetworkName(appName: string): string {
  return `net-${appName}`;
}

/**
 * Resolves the full set of Docker networks a given app should be attached to:
 * - its own tier network (profile-resolved), UNLESS it's "internal" — internal apps
 *   get ONLY their own dedicated isolated network, never a shared tier network.
 * - for each dependsOn target: the dependency's dedicated network if it's
 *   "internal"-typed (this is the ONLY thing that makes it reachable), or the
 *   dependency's own tier network otherwise.
 * - extraNetworks are appended verbatim, unvalidated — this is how an app opts into
 *   the `monitoring` network (see "09 - Adding the Monitoring Network"): e.g.
 *   `extraNetworks: [monitoring]` on an app Prometheus needs to scrape, without that
 *   app (or Prometheus) joining the other's tier network wholesale.
 */
function resolveNetworksForApp(app: AppManifest, loaded: LoadedHomelab): Set<string> {
  const networks = new Set<string>();

  if (app.exposure.type === "internal") {
    networks.add(internalNetworkName(app.name));
  } else {
    networks.add(resolveProfile(loaded, app.exposure.type).network);
  }

  for (const depEntry of app.dependsOn) {
    const depName = dependsOnName(depEntry);
    const dep = loaded.apps.find((a) => a.name === depName)!; // existence guaranteed by validator
    if (dep.exposure.type === "internal") {
      networks.add(internalNetworkName(dep.name));
    } else {
      networks.add(resolveProfile(loaded, dep.exposure.type).network);
    }
  }

  for (const extra of app.extraNetworks) {
    networks.add(extra);
  }

  return networks;
}

/**
 * The network Traefik should route through for this app, i.e. the app's OWN
 * exposure-tier network (or dedicated network, for "internal" apps) — never a
 * dependsOn- or extraNetworks-derived one. Needed to build the disambiguating
 * `traefik.docker.network` label whenever an app ends up on more than one network
 * (e.g. a `public` app that also joins `monitoring` via extraNetworks).
 */
function ownNetworkForApp(app: AppManifest, loaded: LoadedHomelab): string {
  return app.exposure.type === "internal"
    ? internalNetworkName(app.name)
    : resolveProfile(loaded, app.exposure.type).network;
}

/**
 * Builds the Traefik labels for a single app, given its resolved profile.
 * "internal"-typed apps get NO labels at all — no router, no service, no
 * middlewares. They're unreachable from outside Docker entirely, on top of being
 * network-isolated.
 */
function buildTraefikLabels(app: AppManifest, profileName: string, loaded: LoadedHomelab): Record<string, string | boolean> {
  if (app.exposure.type === "internal") return {};
  // schema-level refine guarantees service/auth are present whenever exposure.type !== "internal"
  const service = app.service!;
  const auth = app.auth!;

  const profile = resolveProfile(loaded, profileName);
  const extraMiddlewares = AUTH_MIDDLEWARE_MAP[auth.type] ?? [];
  const allMiddlewares = [...profile.middlewares, ...extraMiddlewares];

  const labels: Record<string, string | boolean> = {
    "traefik.enable": true,
    [`traefik.http.routers.${app.name}.rule`]: `Host(\`${app.exposure.hostname}\`)`,
    [`traefik.http.routers.${app.name}.entrypoints`]: profile.router.entrypoint,
    [`traefik.http.routers.${app.name}.tls`]: profile.router.tls,
    [`traefik.http.services.${app.name}.loadbalancer.server.port`]: String(service.port),
  };

  if (allMiddlewares.length > 0) {
    labels[`traefik.http.routers.${app.name}.middlewares`] = allMiddlewares.join(",");
  }

  // Disambiguate which network Traefik should route through whenever this app ends
  // up on more than one (via dependsOn and/or extraNetworks) — otherwise Traefik has
  // to guess.
  const allNetworks = resolveNetworksForApp(app, loaded);
  if (allNetworks.size > 1) {
    labels["traefik.docker.network"] = ownNetworkForApp(app, loaded);
  }

  return labels;
}

/**
 * Builds this app's compose `depends_on`. Uses the short array form (plain compose
 * "started" semantics) when every entry is a bare name / default condition — matching
 * prior generator output byte-for-byte for every app that doesn't use conditions.
 * Switches to compose's long-form object syntax, with the `service_` prefix compose
 * requires (e.g. "healthy" -> "service_healthy"), as soon as any entry asks for a
 * non-default condition.
 */
function buildDependsOn(app: AppManifest): ComposeService["depends_on"] {
  if (app.dependsOn.length === 0) return undefined;

  const needsLongForm = app.dependsOn.some((e) => dependsOnCondition(e) !== "started");
  if (!needsLongForm) {
    return app.dependsOn.map(dependsOnName);
  }

  const longForm: Record<string, { condition: string }> = {};
  for (const entry of app.dependsOn) {
    longForm[dependsOnName(entry)] = { condition: `service_${dependsOnCondition(entry)}` };
  }
  return longForm;
}

/**
 * Maps an app's optional `healthcheck` block 1:1 onto compose's `healthcheck:` field.
 * Omitted entirely when unset, so compose falls back to the image's own HEALTHCHECK
 * (or no healthcheck at all) rather than us silently asserting empty defaults.
 */
function buildHealthcheck(app: AppManifest): ComposeService["healthcheck"] {
  const hc = app.healthcheck;
  if (!hc) return undefined;

  return {
    test: hc.test,
    interval: hc.interval,
    timeout: hc.timeout,
    retries: hc.retries,
    start_period: hc.startPeriod,
  };
}

/**
 * Maps an app's optional `security` block 1:1 onto compose fields. Every field is
 * omitted (not just falsy) when unset, so compose falls back to its own defaults
 * rather than us silently asserting `cap_add: []` etc.
 */
function buildSecurityFields(app: AppManifest): Pick<ComposeService, "security_opt" | "cap_add" | "cap_drop" | "read_only"> {
  const sec = app.security;
  if (!sec) return {};

  return {
    security_opt: sec.securityOpt,
    cap_add: sec.capAdd,
    cap_drop: sec.capDrop,
    read_only: sec.readOnly,
  };
}

/**
 * Generates the full `platform/compose/generated-apps.yml` content from every loaded app.
 * `secretsEnvFiles` maps app name -> absolute path of its decrypted .env (from secrets.ts),
 * only present for apps that declared `secrets.envFrom`.
 */
export function generateComposeFile(
  root: string,
  loaded: LoadedHomelab,
  secretsEnvFiles: Map<string, string>
): ComposeFile {
  const services: Record<string, ComposeService> = {};

  for (const app of loaded.apps) {
    const volumes = app.storage.map((s) => {
      const hostPath = join(root, "data", app.name, s.name);
      return `${hostPath}:${s.mount}`;
    });

    if (app.dockerSocket) {
      volumes.push("/var/run/docker.sock:/var/run/docker.sock:ro");
    }

    const service: ComposeService = {
      container_name: app.name,
      image: `${app.image.repository}:${app.image.tag}`,
      command: app.command,
      entrypoint: app.entrypoint,
      volumes: volumes.length > 0 ? volumes : undefined,
      environment: Object.keys(app.environment).length > 0 ? app.environment : undefined,
      networks: [...resolveNetworksForApp(app, loaded)],
      labels: { ...app.labels, ...buildTraefikLabels(app, app.exposure.type, loaded) },
      restart: app.restart ?? "unless-stopped",
      ...buildSecurityFields(app),
      healthcheck: buildHealthcheck(app),
      depends_on: buildDependsOn(app),
    };

    const envFile = secretsEnvFiles.get(app.name);
    if (envFile) {
      service.env_file = [relative(join(root, "platform", "compose"), envFile)];
    }

    services[app.name] = service;
  }

  // Networks referenced here are always defined (driver + attachments) in the
  // hand-maintained infrastructure.yml (edge, private, management, monitoring,
  // dockflare-internal, net-authentik-postgres), and homelab apply/deploy always
  // merges both files into a single `docker compose -f infrastructure.yml -f
  // generated-apps.yml` project. Declaring them here as `external: true` would
  // conflict with infrastructure.yml's own (non-external) definition once merged —
  // compose would then refuse to auto-create them. We only need to *reference* the
  // name here so compose accepts services using it; the real definition (including
  // pinned subnets for `private`/`management`/`monitoring`) lives in
  // infrastructure.yml.
  //
  // "internal" apps' dedicated networks (net-<name>) are DIFFERENT: nothing in
  // infrastructure.yml defines them (they're not a routing tier), so this generator
  // must declare them for real, with a driver, not just reference them.
  const networks: Record<string, { name: string } | null> = {};
  for (const profile of loaded.profiles.values()) {
    networks[profile.network] = null;
  }
  for (const app of loaded.apps) {
    if (app.exposure.type === "internal") {
      // Explicit `name:` prevents Compose from applying its "<project>_" prefix to
      // these generator-declared networks (the profile-driven tier networks already
      // avoid this because infrastructure.yml hand-sets `name:` on each of them).
      const netName = internalNetworkName(app.name);
      networks[netName] = { name: netName };
    }
  }

  // Pinned to "compose" (matching platform/compose/, where infrastructure.yml and
  // generated-apps.yml live) rather than "homelab" or letting Compose infer it from
  // cwd. This MUST match whatever Compose project name your pre-existing,
  // hand-brought-up infra containers were originally created under — otherwise every
  // one of them looks like a naming conflict to Compose (container names are unique
  // per Docker daemon, not per project, so a mismatched project label means Compose
  // tries to create a brand new container with an already-taken name instead of
  // recognizing the existing one as already deployed). Check with:
  //   docker inspect <container> --format '{{index .Config.Labels "com.docker.compose.project"}}'
  return { name: "compose", services, networks };
}

export function serializeComposeFile(compose: ComposeFile): string {
  return YAML.stringify(compose, { indent: 2 });
}
