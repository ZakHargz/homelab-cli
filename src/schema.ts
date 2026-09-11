import { z } from "zod";

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

    service: z
      .object({
        port: z.number().int().positive(),
      })
      .strict(),

    // Overrides the image's default entrypoint command -> compose `command`. Needed
    // when one image serves multiple roles via its command arg (e.g. splitting a
    // single server image into "server" and "worker" instances).
    command: z.string().optional(),

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

    auth: z
      .object({
        type: z.enum(["authentik-forward-auth", "oidc", "native", "none"]),
      })
      .strict(),

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

    // Names of other apps this app depends on. Compose `depends_on` is generated from
    // this, AND this app is auto-attached to every named dependency's network(s) so it
    // can reach them by container-name DNS. Order-independent.
    dependsOn: z.array(z.string()).default([]),

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
  .strict();

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
export const AUTH_MIDDLEWARE_MAP: Record<AppManifest["auth"]["type"], string[]> = {
  "authentik-forward-auth": ["authentik-forward-auth@file"],
  oidc: [],
  native: [],
  none: [],
};
