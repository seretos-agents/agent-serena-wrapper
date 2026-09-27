#!/usr/bin/env node
/**
 * codex-staged-server.mjs — test helper for ticket #47.
 *
 * `stageTree(dest)` builds the install-ready plugin tree at `dest` by
 * running .github/scripts/stage-tree.sh — the same script release.yml's
 * "Stage install tree" step calls — so "staged the way release.yml stages
 * it" is literal rather than a re-implementation the tests could drift
 * from. It does not exist yet on this branch; a caller whose spawn fails
 * because the script is missing is seeing the correct pre-fix RED reason,
 * not a helper bug.
 *
 * `resolveCodexServer(root)` reads the Codex MCP server declaration out of
 * `root` (a staged tree, or the repo root itself) using only the resolution
 * rules Codex itself applies:
 *  - `command`/`args` are returned exactly as written. Codex does not expand
 *    `${...}` inside `args`, so this helper must not either — that is the
 *    entire bug ticket #47 fixes.
 *  - `.codex-plugin/plugin.json`'s `mcpServers` is either an inline object
 *    (the pre-#47-fix shape — returned verbatim, `cwd` defaults to `root`
 *    since that inline object carried no `cwd` field at all) or a string
 *    path to another JSON file (the post-fix shape this ticket ships,
 *    `./codex-mcp.json`), resolved relative to `root` and read the same way.
 *  - `cwd: "."`, or an absent `cwd` (the pre-fix inline object's case), maps
 *    to `root`; any other `cwd` value resolves relative to `root`.
 *
 * The inline-object and missing-`cwd` branches above are broader than the
 * one shape `codex-mcp.json` actually uses (string path, `cwd: "."`,
 * always). That breadth is intentional, harmless generality in a test-only
 * resolver, not production surface: it lets this helper also resolve a
 * pre-fix checkout's `.codex-plugin/plugin.json` correctly, without a
 * second resolver to keep in sync. Nothing in production ever constructs or
 * reads through this helper, so a wrong resolution here cannot mask a
 * regression the actual Codex host would hit — it can only make a *test*
 * pass or fail incorrectly, and the two branches this ticket's fix produces
 * (`resolveCodexServer` given the new staged tree) are exercised by every
 * surviving Codex test in codex-manifest.test.mjs / codex-handshake.test.mjs.
 *
 * Not run directly; imported by codex-manifest.test.mjs and
 * codex-handshake.test.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run .github/scripts/stage-tree.sh against this repo, writing the staged
 * install tree to `dest` (created/replaced by the script). Returns the raw
 * spawnSync result — callers decide what a missing script or non-zero exit
 * means for the assertion they're making.
 *
 * @param {string} dest
 */
export function stageTree(dest) {
  const scriptPath = path.join(repoRoot, ".github", "scripts", "stage-tree.sh");
  return spawnSync("bash", [scriptPath, dest], { cwd: repoRoot, encoding: "utf8" });
}

/**
 * @param {string} root
 * @returns {{ command: string, args: string[], cwd: string }}
 */
export function resolveCodexServer(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8")
  );
  const declared = manifest.mcpServers;

  const entry =
    typeof declared === "string"
      ? JSON.parse(fs.readFileSync(path.join(root, declared), "utf8")).mcpServers.serena
      : declared.serena;

  const cwd =
    entry.cwd === undefined || entry.cwd === "." ? root : path.resolve(root, entry.cwd);

  return { command: entry.command, args: entry.args, cwd };
}
