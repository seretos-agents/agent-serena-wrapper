#!/usr/bin/env node
/**
 * serena-boot-wrapper.mjs — Heal .serena/project.yml before launching uvx.
 *
 * Runs before Serena's first read of project.yml so that a corrupted
 * `languages:` block (e.g. `- toml []`) does not crash the MCP server on
 * startup. The heal is best-effort: any error is silently swallowed and uvx
 * is always spawned regardless.
 *
 * Usage (replaces `uvx` as the MCP server command):
 *   node scripts/serena-boot-wrapper.mjs [uvx-args...]
 *
 * The wrapper rewrites a Codex-style `--project-from-cwd` token into
 * `--project <process.cwd()>` before forwarding argv to uvx — Serena 1.5.3's
 * `--project-from-cwd` walks ancestor directories for `.serena/project.yml`
 * before it checks `.git`, so a workspace nested under a directory that has
 * its own `project.yml` would otherwise activate the ancestor's project
 * instead. An explicit `--project` bypasses that discovery entirely. The
 * Claude manifest already passes `--project ${CLAUDE_PROJECT_DIR}` and is
 * forwarded unchanged. It then scans (rewritten) argv for `--project <dir>`
 * to locate the project to heal. If `--project` is absent, the heal step is
 * skipped and uvx is spawned directly.
 *
 * Windows compatibility: spawnSync with shell:false resolves PATH and appends
 * .exe automatically — "uvx" works cross-platform.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readLanguages,
  patchLanguages,
  isValidLanguageEntry,
  detectLanguages,
} from "./serena-reminder-hook.mjs";

// ---------------------------------------------------------------------------
// Heal logic (exported for testing, does NOT run on import)
// ---------------------------------------------------------------------------

/**
 * Heal the `languages:` block in <projectDir>/.serena/project.yml using the
 * same decision logic as the PreToolUse hook's main().
 *
 * - Corrupted / has-invalid / has-duplicates  → filter to valid unique entries;
 *   fall back to detectLanguages if that yields nothing.
 * - Empty                                      → detectLanguages.
 * - Valid and clean                            → no-op.
 * - Detection yields nothing                  → no-op (do NOT call patchLanguages).
 *
 * Any thrown error propagates to the caller; wrap in try/catch at call site.
 *
 * @param {string} projectDir  Resolved absolute path to the project root.
 */
export function healProjectYml(projectDir) {
  const projectYmlPath = path.join(projectDir, ".serena", "project.yml");

  const existingLanguages = readLanguages(projectYmlPath);

  const uniqueLanguages = [...new Set(existingLanguages)];
  const hasInvalidEntries = uniqueLanguages.some(
    (e) => !isValidLanguageEntry(e)
  );
  const isDuplicated = uniqueLanguages.length !== existingLanguages.length;
  const isCorrupted = existingLanguages._corrupted === true;

  if (existingLanguages.length > 0 && (isDuplicated || isCorrupted || hasInvalidEntries)) {
    // Heal: strip invalid scalars, keep only valid unique language keys.
    const cleanLanguages = uniqueLanguages.filter(isValidLanguageEntry);
    if (cleanLanguages.length > 0) {
      patchLanguages(projectYmlPath, cleanLanguages);
    } else {
      // All entries were invalid — fall back to auto-detection.
      const detected = detectLanguages(projectDir);
      if (detected.length > 0) {
        patchLanguages(projectYmlPath, detected);
      }
      // If detection yields nothing, do NOT call patchLanguages.
    }
  } else if (existingLanguages.length === 0) {
    // Languages not yet configured — attempt auto-detection.
    const detected = detectLanguages(projectDir);
    if (detected.length > 0) {
      patchLanguages(projectYmlPath, detected);
    }
    // If detection yields nothing, do NOT call patchLanguages.
  }
  // If languages are present and clean — fast path: no-op.
}

// ---------------------------------------------------------------------------
// Main entry point (exported for testing, guards the spawn)
// ---------------------------------------------------------------------------

/**
 * Parse argv, optionally heal project.yml, then spawn uvx with the given
 * argv as arguments. Always calls spawnSync — errors in the heal step are
 * swallowed. Calls process.exit() with uvx's exit code.
 *
 * @param {string[]} argv  Arguments to forward to uvx (process.argv.slice(2)).
 * @param {{ spawnSync?: Function }} [overrides]  Injectable for testing.
 */
export function run(argv, overrides = {}) {
  const spawnFn = overrides.spawnSync ?? spawnSync;

  // Rewrite Codex's --project-from-cwd into an explicit --project <cwd>,
  // in place, before anything else inspects argv. Serena's own discovery
  // (ancestor-first) is bypassed once --project is explicit.
  const forwarded = argv.flatMap((a) =>
    a === "--project-from-cwd" ? ["--project", process.cwd()] : [a]
  );

  // Locate --project <dir> in the forwarded argv.
  const projectIdx = forwarded.indexOf("--project");
  if (projectIdx !== -1 && projectIdx + 1 < forwarded.length) {
    const projectDir = path.resolve(forwarded[projectIdx + 1]);
    // Best-effort heal — never let an error block the spawn.
    try {
      healProjectYml(projectDir);
    } catch {
      // Silently discard — uvx must always start.
    }
  }
  // If --project is absent (neither manifest emitted it): skip heal entirely.

  const result = spawnFn("uvx", forwarded, { stdio: "inherit", shell: false });
  if (result.error) {
    // Report on stderr (never stdout: that is the MCP channel) so a host's
    // bare "connection closed" is diagnosable.
    process.stderr.write(`serena-boot-wrapper: failed to launch uvx: ${result.error.message}\n`);
    process.exit(1);
    return;
  }
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// Guard: only execute when this file is run directly (not imported).
// ---------------------------------------------------------------------------

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  run(process.argv.slice(2));
}
