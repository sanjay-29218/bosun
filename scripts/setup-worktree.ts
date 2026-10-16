// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, seeds its dev home from the installed Bosun, then warms the web
 * dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
const install = NodeChildProcess.spawnSync("vp i -- --yes", {
  cwd: worktree,
  shell: true,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

// A fresh worktree's dev home starts from the installed Bosun: its settings,
// keybindings, themes and provider keys, then a pruned copy of its projects,
// bots, roles, workflows and recent threads. Copies only, so dev never writes
// back. An existing dev database is left alone.
const SEED_FILES = ["settings.json", "keybindings.json", "client-settings.json", "themes"];
const seedHome = NodePath.join(NodeOS.homedir(), ".bosun", "userdata");
const devHome = NodePath.join(worktree, ".bosun", "userdata");
if (
  NodeFS.existsSync(NodePath.join(seedHome, "statev2.sqlite")) &&
  !NodeFS.existsSync(NodePath.join(devHome, "statev2.sqlite"))
) {
  NodeFS.mkdirSync(NodePath.join(devHome, "secrets"), { recursive: true });
  for (const file of SEED_FILES) {
    const source = NodePath.join(seedHome, file);
    if (NodeFS.existsSync(source)) {
      NodeFS.cpSync(source, NodePath.join(devHome, file), { recursive: true, force: false });
    }
  }
  // Provider API keys only. Signing keys and cloud links stay per instance.
  for (const file of NodeFS.readdirSync(NodePath.join(seedHome, "secrets"))) {
    if (file.startsWith("provider-env-")) {
      NodeFS.copyFileSync(
        NodePath.join(seedHome, "secrets", file),
        NodePath.join(devHome, "secrets", file),
      );
    }
  }
  const seed = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(worktree, "apps", "server", "scripts", "migrate-dev-db.ts")],
    { cwd: worktree, stdio: "inherit" },
  );
  if (seed.status !== 0) {
    process.stderr.write("Seeding the dev database failed; dev starts empty.\n");
  }
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
