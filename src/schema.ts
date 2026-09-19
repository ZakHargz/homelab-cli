import { z } from "zod";

/**
 * A dependsOn entry: either a bare app name (shorthand for the default "started"
 * condition, i.e. plain compose `depends_on: [name]` semantics), or an object naming
 * an explicit wait condition — most usefully "healthy", for apps like migration jobs
 * that need their dependency's healthcheck to pass before they start, not just for
 * the container to have been created.
 */
const DependsOnEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      condition: z.enum(["started", "healthy", "completed_successfully"]).default("started"),
    })
    .strict(),
]);

export type DependsOnEntry = z.infer<typeof DependsOnEntrySchema>;

/** Resolves a dependsOn entry (string shorthand or object form) to the app name. */
export function dependsOnName(entry: DependsOnEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** Resolves a dependsOn entry to its wait condition, defaulting to "started". */
export function dependsOnCondition(entry: DependsOnEntry): "started" | "healthy" | "completed_successfully" {
  return typeof entry === "string" ? "started" : entry.condition;
}

/**
 * Schema for a single app manifest: apps/<name>/app.yml
 */
export const AppManifestSchema = z
  .object({
    name: z.string().min(1),

    image: z
      .object({
        repository: z.string().min(1),
        tag: z.string().min(1).refine((t) => t !== "latest", {
          message: "image.tag must not be 'latest' — pin an explicit version",
        }),
      })
      .strict(),

    // Required for every routed (non-"internal") app — Traefik needs a port to load-
    // balance to. Optional for "internal" apps, since one-off job containers (e.g. a
    // prisma migrate task) never listen on anything and get no Traefik labels at all.
    // Enforced by the object-level refine below.
    service: z
      .object({
        port: z.number().int().positive(),
      })
      .strict()
      .optional(),

    // Overrides the image's default entrypoint command -> compose `command`. Needed
    // when one image serves multiple roles via its command arg (e.g. splitting a
    // single server image into "server" and "worker" instances), or to run a one-off
    // job command (e.g. ["npx", "prisma", "migrate", "deploy"]).
    command: z.union([z.string(), z.array(z.string())]).optional(),

    // Overrides the image's default entrypoint -> compose `entrypoint`. Needed
    // alongside `command` when you have to force a shell wrapper around the real
    // startup logic (e.g. `entrypoint: ["/bin/sh", "-c"]` with a multi-line shell
    // script in `command`, to run a setup step before the image's normal server
    // process).
    entrypoint: z.union([z.string(), z.array(z.string())]).optional(),

    // Overrides compose's `restart` policy (defaults to "unless-stopped" when unset).
    // Job-style containers that are meant to run once and exit (migrations, seed
    // scripts) should set this to "no" so they don't restart-loop after finishing.
    restart: z.enum(["no", "always", "on-failure", "unless-stopped"]).optional(),

    exposure: z
      .object({
        // Four Traefik routing tiers + "internal" for no-hostname, no-Traefik-routing
        // helper containers (e.g. a dedicated docker-socket-proxy for one consumer).
        // NOTE: there is deliberately no "private" exposure type — "private" is a
        // Docker network name (public-tunnel app workloads), not a routing tier. The
        // only WARP-only tier is "management", and it is always Authentik-gated.
        // See the "Homelab Networking" ground-truth notes for the full model.
        type: z.enum(["public", "protected", "oidc", "management", "internal"]),
        hostname: z.string().min(1).optional(),
      })
      .strict()
      .refine((e) => e.type === "internal" || !!e.hostname, {
        message: "exposure.hostname is required unless exposure.type is 'internal'",
      }),

    // Required for every routed (non-"internal") app (drives which Traefik auth
    // middleware gets appended). Optional for "internal" apps. Enforced below.
    auth: z
      .object({
        type: z.enum(["authentik-forward-auth", "oidc", "native", "none"]),
      })
      .strict()
      .optional(),

    // Optional compose healthcheck, 1:1 with compose's own `healthcheck:` block.
    // Mainly useful so OTHER apps can `dependsOn: [{ name, condition: healthy }]`
    // this one instead of just waiting for the container to start.
    healthcheck: z
      .object({
        test: z.union([z.string(), z.array(z.string())]),
        interval: z.string().optional(),
        timeout: z.string().optional(),
        retries: z.number().int().positive().optional(),
        startPeriod: z.string().optional(),
      })
      .strict()
      .optional(),

    storage: z
      .array(
        z
          .object({
            name: z.string().min(1),
            mount: z.string().min(1),
          })
          .strict()
      )
      .default([]),

    environment: z.record(z.string(), z.string()).default({}),

    secrets: z
      .object({
        envFrom: z.string().min(1),
      })
      .strict()
      .optional(),

    // Opt-in container hardening knobs, mapped 1:1 onto compose fields by the generator.
    // Every field is optional — apps that don't set `security` at all get compose's defaults.
    security: z
      .object({
        securityOpt: z.array(z.string()).optional(), // -> compose `security_opt`
        capAdd: z.array(z.string()).optional(), // -> compose `cap_add`
        capDrop: z.array(z.string()).optional(), // -> compose `cap_drop`
        readOnly: z.boolean().optional(), // -> compose `read_only`
      })
      .strict()
      .optional(),

    // Other apps this app depends on. Compose `depends_on` is generated from this, AND
    // this app is auto-attached to every named dependency's network(s) so it can reach
    // them by container-name DNS. Order-independent. Plain strings default to
    // compose's normal "started" wait condition; use the object form with
    // `condition: healthy` when the dependency has a `healthcheck` and this app needs
    // it to actually be ready (e.g. a migration job waiting on its database).
    dependsOn: z.array(DependsOnEntrySchema).default([]),

    // Extra network names to attach this app to, verbatim, IN ADDITION to its own
    // exposure-tier network (and any dependsOn-driven networks). NOT validated against
    // anything — may reference hand-maintained infrastructure.yml networks the loader
    // has no knowledge of. This is how an app opts into the `monitoring` network (see
    // "09 - Adding the Monitoring Network"): e.g. `extraNetworks: [monitoring]` on an
    // app that Prometheus needs to scrape, without joining `private`/`management`
    // wholesale from the monitoring side.
    extraNetworks: z.array(z.string()).default([]),

    // Purely organizational — no network/routing/validation semantics at all. Used
    // for: (1) a "com.homelab.group" Docker label on every service, and (2)
    // group-aware CLI commands (`homelab group deploy/restart/logs <group>`).
    group: z.string().min(1).optional(),

    // Arbitrary extra Docker labels, passed through verbatim on top of whatever the
    // generator itself sets (traefik.*, com.homelab.group, etc — these can't be
    // overridden this way, extra labels only ADD, never replace). Primarily for
    // 3rd-party tools that discover config via labels rather than their own config
    // file, e.g. Glance's docker-containers widget (`glance.name`, `glance.icon`,
    // `glance.description`, `glance.url`). See "13 - Docker Socket Access and
    // Container Discovery" in the Homelab Networking notes.
    labels: z.record(z.string(), z.string()).default({}),

    // When true, bind-mounts /var/run/docker.sock into the container READ-ONLY.
    // Deliberately a single explicit boolean rather than a generic arbitrary-host-
    // path mount escape hatch — docker.sock access is root-equivalent on the host,
    // so this is scoped to exactly one well-known, auditable use case (tools like
    // Glance's docker-containers widget that need to list container state) rather
    // than opening up arbitrary host bind mounts through app.yml.
    dockerSocket: z.boolean().default(false),
  })
  .strict()
  .refine((app) => app.exposure.type === "internal" || (!!app.service && !!app.auth), {
    message: "service and auth are required unless exposure.type is 'internal'",
  });

export type AppManifest = z.infer<typeof AppManifestSchema>;

/**
 * Schema for a profile: platform/profiles/<name>.yml
 * Note: "internal"-typed apps deliberately have NO profile file — they're exempted
 * from profile resolution entirely in the validator and generator.
 */
export const ProfileSchema = z
  .object({
    name: z.string().min(1),
    router: z
      .object({
        entrypoint: z.string().min(1),
        tls: z.boolean().default(true),
      })
      .strict(),
    middlewares: z.array(z.string()).default([]),
    network: z.string().min(1),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

/** auth.type -> extra Traefik middleware names appended on top of the profile's own list */
export const AUTH_MIDDLEWARE_MAP: Record<NonNullable<AppManifest["auth"]>["type"], string[]> = {
  "authentik-forward-auth": ["authentik-forward-auth@file"],
  oidc: [],
  native: [],
  none: [],
};
