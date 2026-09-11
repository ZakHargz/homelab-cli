# homelab-cli

A small CLI for managing a self-hosted homelab as a set of declarative
`app.yml` manifests, generated into Docker Compose. You write one YAML file per
app describing its image, port, hostname, and how it should be exposed and
authenticated — the CLI resolves networking, Traefik labels, secrets, and
dependencies, and generates the actual Compose file for you.

It does **not** replace Traefik, Docker Compose, or your auth provider — it's a
thin, opinionated layer on top of them that keeps your apps consistent and
declarative instead of hand-writing Compose + Traefik labels for every service.

## Install

Prebuilt binaries are published on the [Releases page](https://github.com/ZakHargz/homelab-cli/releases)
for `linux-x64`, `linux-arm64`, and `darwin-arm64`. On your homelab host:

```bash
curl -L https://github.com/ZakHargz/homelab-cli/releases/latest/download/homelab-linux-x64 -o homelab
chmod +x homelab
sudo mv homelab /usr/local/bin/homelab
```

(swap `homelab-linux-x64` for `homelab-linux-arm64` or `homelab-darwin-arm64` to match your host)

Verify it works:

```bash
homelab --help
```

### Building from source

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/ZakHargz/homelab-cli
cd homelab-cli
bun install
bun run build:cli   # -> bin/homelab
```

## Prerequisites

- **Docker + Docker Compose v2** on the host you're deploying to
- **[SOPS](https://github.com/getsops/sops)** installed and on `$PATH`, with an
  [age](https://github.com/FiloSottile/age) key set up, if you want to use
  `secrets.envFrom` on any app (fully optional — apps without a `secrets:`
  block don't need this at all)

## Folder structure

homelab-cli expects a specific layout in whatever directory you run it from
(pass that path via `HOMELAB_ROOT`, or run the binary from inside it):

```
your-homelab/
├── apps/
│   ├── whoami/
│   │   └── app.yml            # one folder per app, folder name == app.yml's `name`
│   ├── myapp/
│   │   └── app.yml
│   └── myapp-db/
│       └── app.yml
│
├── platform/
│   ├── compose/
│   │   ├── infrastructure.yml     # hand-maintained: Traefik, networks, anything
│   │   │                          # not modeled as an app.yml
│   │   └── generated-apps.yml     # AUTO-GENERATED — never edit, never commit
│   ├── profiles/
│   │   ├── public.yml             # one file per exposure tier your apps use
│   │   └── protected.yml
│   └── config/
│       └── traefik/
│           └── dynamic/
│               └── auth.yml       # Traefik file-provider config (middlewares
│                                   # referenced from profiles as `name@file`)
│
├── secrets/
│   └── *.enc.yml                  # SOPS-encrypted, safe to commit
│
├── data/
│   └── <app-name>/<volume-name>/  # bind-mount data, one subfolder per
│                                   # app.yml `storage` entry — gitignore this
│
└── .sops.yaml                     # SOPS encryption rules
```

A complete working example of every file above lives in [`examples/`](./examples) —
copy it as a starting point.

## Quickstart

```bash
cp -r homelab-cli/examples my-homelab
cd my-homelab
homelab app validate        # check everything parses and cross-references correctly
homelab app generate         # preview the generated compose, no containers touched
homelab apply                 # generate + docker compose up -d --remove-orphans
```

## Concepts

### Exposure tiers (`exposure.type`)

Every app declares how it's reached:

| Type | Meaning |
|---|---|
| `public` | Routed through Traefik on a public hostname, no auth gate — the app handles its own security (or genuinely needs none) |
| `protected` | Routed through Traefik on a public hostname, gated by whatever forward-auth middleware the `protected` profile points at |
| `oidc` | Routed through Traefik on a public hostname, no Traefik-level gate — the app itself is expected to act as a proper OIDC client |
| `management` | Same idea as `protected`/`oidc` but intended for an internal-only/VPN-gated network tier — define a `management` profile pointing at whatever internal network you use |
| `internal` | No hostname, no Traefik router, no public label at all. Gets its own dedicated, isolated Docker network. Only reachable by apps that declare it in `dependsOn`. Use this for databases, caches, or anything that should never be reachable except by one specific app |

Each tier (except `internal`) needs a matching `platform/profiles/<tier>.yml`
file — that's what actually defines the Traefik entrypoint, TLS setting,
middlewares, and which Docker network the tier uses. `internal` apps
deliberately have no profile — they're exempt from all of this.

### Auth (`auth.type`)

Independent from `exposure.type` — this controls which *extra* Traefik
middleware gets appended on top of whatever the profile already sets:

| Type | Effect |
|---|---|
| `authentik-forward-auth` | Appends the `forward-auth@file` middleware (or whatever middleware name your setup uses — see `platform/config/traefik/dynamic/auth.yml`). Despite the name, this works with any forward-auth provider implementing Traefik's `forwardAuth` contract (Authentik, Authelia, oauth2-proxy, etc), not literally just Authentik |
| `oidc` | No extra middleware — the app is expected to handle OIDC itself |
| `native` | No extra middleware — the app has its own non-OIDC auth (e.g. a bundled login system) |
| `none` | No extra middleware, no auth at all |

### Profiles (`platform/profiles/<name>.yml`)

```yaml
name: protected          # must match the filename (minus .yml)
router:
  entrypoint: websecure   # Traefik entrypoint name
  tls: true
middlewares:
  - forward-auth@file     # applied to every app using this profile, in order,
                           # BEFORE whatever auth.type adds on top
network: protected        # Docker network name — must be defined in
                           # infrastructure.yml (or be a tier the generator
                           # manages itself, for "internal" apps)
```

### Storage (`storage`)

```yaml
storage:
  - name: data
    mount: /var/lib/postgresql/data
```

Becomes a bind mount at `data/<app-name>/<name>:<mount>`, relative to your
homelab root. Not a Docker named volume — plain host directories, so you can
`ls`/`cp`/back them up directly.

### Secrets (`secrets.envFrom`)

```yaml
secrets:
  envFrom: secrets/myapp.enc.yml
```

Points at a SOPS-encrypted YAML file (flat key/value). At `apply`/`deploy`
time, the CLI decrypts it to `platform/state/secrets/<app>.env` (gitignore
this directory — it holds real plaintext secrets) and wires it up as the
container's `env_file`. Requires `sops` on `$PATH` and a working age identity.

To create one:

```bash
cat <<'EOF' > /tmp/myapp-secrets.yml
DATABASE_URL: postgresql://user:pass@myapp-db:5432/myapp
EOF
sops -e /tmp/myapp-secrets.yml > secrets/myapp.enc.yml
```

### Dependencies (`dependsOn`)

```yaml
dependsOn:
  - myapp-db
```

Generates a plain Compose `depends_on` entry (no `condition:` support — your
app should handle a transient connection retry on startup) and auto-attaches
this app to `myapp-db`'s network so it's reachable by container name
(`myapp-db:5432`), even if `myapp-db` is `internal`-typed and otherwise
completely unreachable from anywhere else.

### Extra networks (`extraNetworks`)

```yaml
extraNetworks:
  - monitoring
```

Attaches the app to additional, unvalidated network names on top of its own
tier network — useful for things like a Prometheus scrape network that
shouldn't require joining an app's whole exposure tier.

### Docker labels (`labels`, `dockerSocket`)

```yaml
labels:
  glance.name: My App
  glance.icon: si:myapp
dockerSocket: true
```

`labels` passes through arbitrary extra Docker labels (never able to override
the generator's own `traefik.*` labels) — useful for tools that discover
config via labels, like [Glance](https://github.com/glanceapp/glance)'s
`docker-containers` widget. `dockerSocket: true` mounts `/var/run/docker.sock`
read-only — deliberately a single explicit boolean rather than a general
arbitrary-host-path mount, since socket access is root-equivalent on the host.

### Groups (`group`)

```yaml
group: myapp
```

Purely organizational — lets `homelab group deploy/restart/logs <group>`
operate on every app sharing the same group name in one command (e.g. an app
and its dedicated database).

## Commands

| Command | What it does |
|---|---|
| `homelab app validate [name]` | Checks every `app.yml` (or just one) parses, cross-references resolve, and secrets decrypt — no containers touched |
| `homelab app generate [name]` | Validates, regenerates `generated-apps.yml`, and shows a diff — no `docker compose up` |
| `homelab apply` | Validates, decrypts secrets, regenerates compose, then `docker compose up -d --remove-orphans` for everything |
| `homelab app deploy <name>` | Same pipeline as `apply`, but only brings up one app |
| `homelab app restart <name>` | `docker compose restart` for one app |
| `homelab app logs <name>` | `docker compose logs` for one app |
| `homelab app destroy <name>` | `docker compose rm -sf` for one app |
| `homelab status` | Table of every app's deployment state |
| `homelab group deploy/restart/logs <group>` | Same as the single-app commands, scoped to every app sharing a `group` |

## Example: infrastructure.yml

See [`examples/platform/compose/infrastructure.yml`](./examples/platform/compose/infrastructure.yml)
for a complete, minimal, working file — plain Traefik on ports 80/443 with a
`public` and `protected` network, no CDN/tunnel dependency. Swap the `ports:`
publish for whatever ingress you actually use (Cloudflare Tunnel, a VPN-only
network, etc) — homelab-cli itself has no opinion on how traffic reaches
Traefik, only on what happens after it does.

## Example: apps folder

See [`examples/apps/`](./examples/apps) for three worked examples covering the
main patterns:

- [`whoami/app.yml`](./examples/apps/whoami/app.yml) — simplest possible app: `public`, no auth, no storage, no secrets
- [`myapp/app.yml`](./examples/apps/myapp/app.yml) — `protected` + storage + secrets + a dependency on its own database
- [`myapp-db/app.yml`](./examples/apps/myapp-db/app.yml) — an `internal`-tier database, unreachable except by `myapp`

## Development

```bash
bun install
bun run typecheck
bun run build:cli          # local binary at bin/homelab
```

CI runs typecheck + a sanity build on every push/PR. Pushing a `v*` tag
triggers the release workflow, which cross-compiles `linux-x64`,
`linux-arm64`, and `darwin-arm64` binaries and attaches them to a new GitHub
Release.
