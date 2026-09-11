#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { apply } from "./commands/apply";
import { deploy } from "./commands/deploy";
import { generate } from "./commands/generate";
import { restart } from "./commands/restart";
import { logs } from "./commands/logs";
import { validate } from "./commands/validate";
import { destroy } from "./commands/destroy";
import { status } from "./commands/status";
import { groupDeploy, groupRestart, groupLogs } from "./commands/group";

/** Homelab root: defaults to cwd, override with HOMELAB_ROOT env var. */
const root = process.env.HOMELAB_ROOT ?? process.cwd();

const appValidate = defineCommand({
  meta: { name: "validate", description: "Validate one app (or all apps if omitted)" },
  args: { name: { type: "positional", required: false } },
  async run({ args }) {
    const ok = await validate({ root, appName: args.name });
    if (!ok) process.exit(1);
  },
});

const appGenerate = defineCommand({
  meta: { name: "generate", description: "Preview: validate + regenerate + diff, no docker compose up" },
  args: { name: { type: "positional", required: false } },
  async run({ args }) {
    await generate({ root, appName: args.name });
  },
});

const appDeploy = defineCommand({
  meta: { name: "deploy", description: "Deploy a single app" },
  args: { name: { type: "positional", required: true } },
  async run({ args }) {
    await deploy({ root, appName: args.name });
  },
});

const appRestart = defineCommand({
  meta: { name: "restart", description: "Restart a single app" },
  args: { name: { type: "positional", required: true } },
  async run({ args }) {
    await restart({ root, appName: args.name });
  },
});

const appLogs = defineCommand({
  meta: { name: "logs", description: "Tail a single app's logs" },
  args: {
    name: { type: "positional", required: true },
    tail: { type: "string", required: false, default: "200" },
    noFollow: { type: "boolean", required: false, default: false },
  },
  async run({ args }) {
    await logs({ root, appName: args.name, tail: Number(args.tail), follow: !args.noFollow });
  },
});

const appDestroy = defineCommand({
  meta: { name: "destroy", description: "Remove a single app's container (data/ is untouched)" },
  args: { name: { type: "positional", required: true } },
  async run({ args }) {
    await destroy({ root, appName: args.name });
  },
});

const app = defineCommand({
  meta: { name: "app", description: "Per-app operations" },
  subCommands: {
    validate: appValidate,
    generate: appGenerate,
    deploy: appDeploy,
    restart: appRestart,
    logs: appLogs,
    destroy: appDestroy,
  },
});

const groupDeployCmd = defineCommand({
  meta: { name: "deploy", description: "Deploy every app sharing a group value" },
  args: { name: { type: "positional", required: true } },
  async run({ args }) {
    await groupDeploy({ root, group: args.name });
  },
});

const groupRestartCmd = defineCommand({
  meta: { name: "restart", description: "Restart every app sharing a group value" },
  args: { name: { type: "positional", required: true } },
  async run({ args }) {
    await groupRestart({ root, group: args.name });
  },
});

const groupLogsCmd = defineCommand({
  meta: { name: "logs", description: "Tail logs across every app sharing a group value" },
  args: {
    name: { type: "positional", required: true },
    tail: { type: "string", required: false, default: "200" },
    noFollow: { type: "boolean", required: false, default: false },
  },
  async run({ args }) {
    await groupLogs({ root, group: args.name, tail: Number(args.tail), follow: !args.noFollow });
  },
});

const group = defineCommand({
  meta: { name: "group", description: "Operations across every app sharing a group value" },
  subCommands: {
    deploy: groupDeployCmd,
    restart: groupRestartCmd,
    logs: groupLogsCmd,
  },
});

const applyCmd = defineCommand({
  meta: { name: "apply", description: "Validate, generate, and reconcile every app" },
  async run() {
    await apply({ root });
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Show NAME / STATUS / EXPOSURE / AUTH / GROUP for every app" },
  async run() {
    await status({ root });
  },
});

const main = defineCommand({
  meta: { name: "homelab", description: "Declarative homelab manager" },
  subCommands: { app, group, apply: applyCmd, status: statusCmd },
});

runMain(main);
