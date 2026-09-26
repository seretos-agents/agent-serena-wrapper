#!/usr/bin/env node
/**
 * PreToolUse hook — Serena MCP reminder.
 *
 * Fires on Read, Glob, and Grep. When the working directory is inside a
 * Serena-active repository (detected by walking up for .serena/project.yml),
 * injects an additionalContext reminder encouraging use of Serena MCP tools
 * over raw file exploration. Otherwise exits silently (pass-through).
 *
 * If .serena/project.yml has an empty `languages:` list, the hook attempts
 * to detect languages from project source files and patches the config so
 * symbol tools become active without manual editing. If no language can be
 * detected a targeted warning is injected into additionalContext instead of
 * failing silently.
 *
 * If .serena/project.yml has a corrupted `languages:` block (e.g. duplicate
 * entries caused by orphaned lines separated by blank lines), the hook
 * deduplicates and rewrites the block to a clean canonical form.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MARKER = path.join(".serena", "project.yml");

const REMINDER =
  "Note: this repository has Serena MCP semantic code tools available " +
  "(find_symbol with include_body, find_referencing_symbols, " +
  "find_implementations, find_declaration, get_symbols_overview). For " +
  "understanding code structure — finding where a symbol is defined, " +
  "tracing callers/references, reading a single class or method body, " +
  "navigating inheritance, or performing a project-wide rename — prefer " +
  "Serena MCP tools over raw Read/Glob/Grep. They are more precise, " +
  "token-efficient, and already active in this session.";

const NO_LANGUAGE_WARNING =
  " Warning: .serena/project.yml has no languages configured — " +
  "symbol tools are inactive until at least one language is added " +
  "under 'languages:' in .serena/project.yml.";

/** Extension → Serena language key mapping. */
const EXT_TO_LANGUAGE = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "cpp",
  ".h": "cpp",
  ".kt": "kotlin",
  ".swift": "swift",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

/** Source languages sort before config/doc languages so the first entry is a real LSP. */
const SOURCE_LANGUAGES = new Set([
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "ruby",
  "php",
  "cpp",
  "kotlin",
  "swift",
]);

/**
 * Walk up from `startDir` looking for `.serena/project.yml`.
 * Returns the resolved path to `project.yml` if found, or `null` if the
 * filesystem root is reached without finding one.
 */
function isSerenaActive(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, MARKER);
    try {
      fs.accessSync(candidate, fs.constants.F_OK);
      return candidate;
    } catch {
      // not here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Reads the `languages:` block from a project.yml file using line-based
 * scanning. Returns an array of language strings already configured (with
 * duplicates preserved so callers can detect corruption), or `[]` if the
 * block is present but empty, absent, or the file cannot be read.
 *
 * Block extent: starting at the `languages:` line, the block consists of all
 * following lines up to — but not including — the next line that is a real
 * column-0 YAML key (`/^[a-zA-Z_][a-zA-Z0-9_]*:/`) or EOF. Comment lines
 * (`/^\s*#/`, at column 0 OR indented) and blank/whitespace-only lines do NOT
 * terminate the block; they are part of it. This lets column-0 comments
 * between entries be skipped without truncating the block.
 *
 * Handles `languages:` both mid-file (followed by \n) and at EOF (no trailing
 * newline).
 */
function readLanguages(projectYmlPath) {
  let text;
  try {
    text = fs.readFileSync(projectYmlPath, "utf8");
  } catch {
    return [];
  }

  // --- Inline flow form: `languages: []` or `languages: [a, b, c]` ---
  // Must be tried before the block-style logic to avoid false matches.
  const inlineMatch = text.match(/^languages:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    const entries = inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    return entries;
  }

  // --- Block-style: line-based scanning ---
  // Split into lines (preserve \r so CRLF files are handled — \r is treated as
  // whitespace in blank-line detection, not as a key character).
  const allLines = text.split("\n");

  // Find the `languages:` line.
  let langLineIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (/^languages:[ \t]*(\r)?$/.test(allLines[i])) {
      langLineIdx = i;
      break;
    }
  }
  if (langLineIdx === -1) {
    return [];
  }

  // Collect all block body lines: lines after `languages:` that are NOT a
  // real column-0 YAML key. Comment lines and blank lines stay inside.
  const blockLines = [];
  for (let i = langLineIdx + 1; i < allLines.length; i++) {
    const line = allLines[i];
    // A real column-0 YAML key terminates the block.
    if (/^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  // Check for orphan/foreign lines: lines that are neither `- entry`, nor
  // blank/whitespace-only, nor a comment. These indicate a corrupted block.
  let corrupted = false;
  for (const line of blockLines) {
    if (line === "") continue; // trailing empty after final \n split
    if (/^- /.test(line)) continue; // valid entry
    if (/^[ \t\r]*$/.test(line)) continue; // blank / whitespace-only
    if (/^\s*#/.test(line)) continue; // comment (column-0 or indented) — not corruption
    // Anything else is a foreign/orphan line (e.g. ` []`).
    corrupted = true;
    break;
  }

  // Filter to only actual `- entry` lines; ignore blank/whitespace-only lines
  // and comment lines. Strip inline comments (# ...) before trimming so
  // `- python  # backend` yields `python`, not `python  # backend`.
  const entries = blockLines
    .filter((l) => /^- /.test(l))
    .map((l) => l.replace(/^- /, "").replace(/#.*$/, "").trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  if (corrupted) {
    // Mark the array as corrupted without affecting length or JSON serialisation.
    Object.defineProperty(entries, "_corrupted", {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  return entries;
}

/**
 * Scans the repo root and every immediate subdirectory (depth 1) for files
 * whose extensions map to Serena language keys. Skips `.git`, `node_modules`,
 * and `.serena`. Caps total entries examined at 200.
 *
 * Returns a deduplicated, priority-ordered array: source languages first,
 * then config/doc languages.
 */
function detectLanguages(repoRoot) {
  const SKIP_DIRS = new Set([".git", "node_modules", ".serena"]);
  const detected = new Set();
  let budget = 200;

  /**
   * Examine a pre-read entries array for a single directory.
   * Returns false when budget exhausted.
   */
  function scanEntries(entries) {
    for (const entry of entries) {
      if (budget <= 0) return false;
      budget--;
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const lang = EXT_TO_LANGUAGE[ext];
        if (lang) {
          detected.add(lang);
        }
      }
    }
    return true; // budget not yet exhausted
  }

  // Read root entries once; reuse for both file scanning and subdir iteration.
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return sortLanguages(detected);
  }

  // Scan root files first.
  if (!scanEntries(rootEntries)) {
    return sortLanguages(detected);
  }

  // Scan immediate subdirectories (depth 1 only).
  for (const entry of rootEntries) {
    if (budget <= 0) break;
    if (
      entry.isDirectory() &&
      !SKIP_DIRS.has(entry.name) &&
      !entry.name.startsWith(".")
    ) {
      let subEntries;
      try {
        subEntries = fs.readdirSync(path.join(repoRoot, entry.name), {
          withFileTypes: true,
        });
      } catch {
        continue; // unreadable — skip silently
      }
      if (!scanEntries(subEntries)) {
        break;
      }
    }
  }

  return sortLanguages(detected);
}

/** Sort detected languages: source languages first, then config/doc languages. */
function sortLanguages(languageSet) {
  const source = [];
  const config = [];
  for (const lang of languageSet) {
    if (SOURCE_LANGUAGES.has(lang)) {
      source.push(lang);
    } else {
      config.push(lang);
    }
  }
  return [...source, ...config];
}

/**
 * Returns true when an entry is a valid Serena language key.
 * Valid keys are lowercase ASCII identifiers: start with a letter, then
 * letters / digits / underscores only — no spaces, brackets, or punctuation.
 * This catches corrupt scalars like `markdown []` (contains a space).
 */
function isValidLanguageEntry(entry) {
  return /^[a-z][a-z0-9_]*$/.test(entry);
}

/**
 * Resolves the path where the throttle state file should be stored.
 *
 * Base dir: `env.CLAUDE_PLUGIN_DATA` when set and non-empty; otherwise
 * `<os.tmpdir()>/agent-serena-wrapper`.
 * Subdirectory: `reminder-state/` beneath that base.
 * Filename: `<sessionId>.json` when `sessionId` is non-empty;
 * `no-session.json` otherwise.
 *
 * Does NOT create any directories — creation is deferred to `writeState`.
 *
 * @param {string} sessionId - The current session identifier (may be empty).
 * @param {object} [env=process.env] - Environment variables (injectable for tests).
 * @returns {string} Absolute path to the state file.
 */
function resolveStateFilePath(sessionId, env = process.env) {
  const pluginData = env.CLAUDE_PLUGIN_DATA;
  const baseDir =
    typeof pluginData === "string" && pluginData !== ""
      ? pluginData
      : path.join(os.tmpdir(), "agent-serena-wrapper");
  const stateDir = path.join(baseDir, "reminder-state");
  const filename = sessionId !== "" ? `${sessionId}.json` : "no-session.json";
  return path.join(stateDir, filename);
}

/**
 * Reads the throttle state from the state file.
 * Returns `{ counter: 0, session_id: "" }` on any failure (missing file,
 * corrupt JSON, or invalid shape).
 *
 * State schema: `{ counter: number, session_id: string }`.
 */
function readState(stateFilePath) {
  const zero = { counter: 0, session_id: "" };
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Number.isFinite(parsed.counter) ||
      parsed.counter < 0 ||
      !Number.isInteger(parsed.counter) ||
      typeof parsed.session_id !== "string"
    ) {
      return zero;
    }
    return { counter: parsed.counter, session_id: parsed.session_id };
  } catch {
    return zero;
  }
}

/**
 * Writes the throttle state to the state file.
 * Creates the parent directory (recursively) if it does not already exist.
 * Silently swallows any write error — the hook must never block a tool call.
 */
function writeState(stateFilePath, state) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(state), "utf8");
  } catch {
    // Silently swallow — never block the tool call.
  }
}

/**
 * Pure throttle decision function (no I/O).
 *
 * Fires at call positions 1, 1+N, 1+2N … (interval=10 → calls 1, 11, 21).
 *
 * - If `sessionId` is non-empty and differs from `state.session_id`, it is a
 *   new session: fire immediately and reset the counter to 1.
 * - Otherwise: increment the counter; fire when the previous counter was 0
 *   (first call) or when the new counter lands on a multiple-of-interval + 1.
 *
 * Returns `{ shouldFire, newCounter, newSessionId }`.
 */
function computeThrottle(state, sessionId, interval) {
  const isNewSession = sessionId !== "" && sessionId !== state.session_id;
  if (isNewSession) {
    return { shouldFire: true, newCounter: 1, newSessionId: sessionId };
  }
  const newCounter = state.counter + 1;
  const shouldFire = state.counter === 0 || newCounter % interval === 1;
  return { shouldFire, newCounter, newSessionId: state.session_id };
}

/**
 * Rewrites the `languages:` block in project.yml using line-based scanning,
 * preserving all comments and other fields. Uses write-to-temp-then-rename
 * for atomicity. Swallows any write error — the hook must never block a call.
 *
 * The replaced span runs from the `languages:` line through the last entry or
 * orphan line of the block, EXCLUDING any trailing comment/blank lines that
 * come after the last entry. This ensures that a trailing `# the encoding`
 * comment is never consumed and survives the rewrite unchanged.
 *
 * Block extent (same as readLanguages): lines after `languages:` that are not
 * a real column-0 YAML key. Comment lines and blank/whitespace-only lines do
 * NOT terminate the block; they are part of it.
 *
 * Handles `languages:` both mid-file (followed by \n) and at EOF (no trailing
 * newline), as well as an already-populated list.
 */
function patchLanguages(projectYmlPath, languages) {
  let text;
  try {
    text = fs.readFileSync(projectYmlPath, "utf8");
  } catch {
    return;
  }

  const newBlock =
    "languages:\n" + languages.map((l) => `- ${l}\n`).join("");

  // Pass 1: inline flow form — `languages: []` or `languages: [a, b, c]`.
  // Convert to canonical block form so `[]` residue is fully eliminated.
  let patched = text.replace(/^languages:\s*\[[^\]]*\]/m, newBlock);

  // Pass 2: block-style form — line-based scanning.
  if (patched === text) {
    const allLines = text.split("\n");

    // Find the `languages:` line index.
    let langLineIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
      if (/^languages:[ \t]*(\r)?$/.test(allLines[i])) {
        langLineIdx = i;
        break;
      }
    }

    if (langLineIdx !== -1) {
      // Find the end of the block: first line that is a real column-0 YAML key.
      let blockEndIdx = allLines.length; // exclusive end of block body
      for (let i = langLineIdx + 1; i < allLines.length; i++) {
        if (/^[a-zA-Z_][a-zA-Z0-9_]*:/.test(allLines[i])) {
          blockEndIdx = i;
          break;
        }
      }

      // Walk back from blockEndIdx to find the last non-trailing-comment line.
      // Only trailing COMMENT lines are excluded from the replacement span so
      // they survive the rewrite (e.g. `# the encoding` after the last entry).
      // Blank/whitespace-only lines are included in the span and consumed —
      // this removes stale blank separators from corrupted blocks and avoids
      // stray \r characters from CRLF blank lines leaking into the output.
      let lastEntryIdx = langLineIdx; // default: no body lines → replace only the key line
      for (let i = blockEndIdx - 1; i > langLineIdx; i--) {
        const line = allLines[i];
        // Skip trailing comment-only lines (exclude them from the span).
        if (/^\s*#/.test(line)) {
          continue;
        }
        // Blank lines and all other lines stop the walk-back and are included.
        lastEntryIdx = i;
        break;
      }

      // Reconstruct: beforeParts + newBlock + afterParts.
      // split("\n") / join("\n") are exact inverses of each other, so:
      //   allLines.join("\n") === text
      // We replace allLines[langLineIdx..lastEntryIdx] with newBlock (which
      // already ends with "\n"). The separator between beforeParts and newBlock
      // is supplied explicitly; no separator needed between newBlock and
      // afterParts because newBlock's trailing "\n" plays that role.
      const beforeParts = allLines.slice(0, langLineIdx);
      const afterParts  = allLines.slice(lastEntryIdx + 1);

      patched =
        (beforeParts.length > 0 ? beforeParts.join("\n") + "\n" : "") +
        newBlock +
        afterParts.join("\n");
    }
  }

  // Pass 3 (fallback): `languages:` at EOF with no trailing newline.
  // Replace the bare key; newBlock already ends with \n which is valid YAML.
  if (patched === text) {
    patched = text.replace(/^languages:[ \t]*$/m, newBlock);
  }

  if (patched === text) {
    // Nothing changed (block not found or no-op) — skip write.
    return;
  }

  const dir = path.dirname(projectYmlPath);
  const tmp = path.join(dir, `.project.yml.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmp, patched, "utf8");
    fs.renameSync(tmp, projectYmlPath);
  } catch {
    // Silently swallow — never block the tool call.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
}

function main() {
  // Read stdin (may be empty or malformed — be fully fault-tolerant).
  let input = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) {
      input = JSON.parse(raw);
    }
  } catch {
    // Empty or malformed stdin — just pass through.
    process.exit(0);
  }

  // Determine working directory from payload, fall back to process.cwd().
  const cwd =
    (typeof input.cwd === "string" && input.cwd) ? input.cwd : process.cwd();

  // Scope check: only act when Serena is active in this repo.
  const projectYmlPath = isSerenaActive(cwd);
  if (projectYmlPath === null) {
    process.exit(0);
  }

  // Determine repo root (parent of .serena/).
  const repoRoot = path.dirname(path.dirname(projectYmlPath));

  // --- Throttle setup ---
  // Resolve session id first so it can be used to key the state file path.
  const incomingSession =
    typeof input.session_id === "string" ? input.session_id : "";

  const stateFilePath = resolveStateFilePath(incomingSession, process.env);

  // Parse SERENA_REMINDER_INTERVAL: use only a positive integer, else fall back to 10.
  let interval = 10;
  const envInterval = process.env.SERENA_REMINDER_INTERVAL;
  if (envInterval !== undefined && envInterval !== "") {
    const parsed = Number(envInterval);
    if (Number.isInteger(parsed) && parsed > 0) {
      interval = parsed;
    }
  }

  const state = readState(stateFilePath);
  const { shouldFire, newCounter, newSessionId } = computeThrottle(
    state,
    incomingSession,
    interval
  );
  writeState(stateFilePath, { counter: newCounter, session_id: newSessionId });

  // --- Decide what additionalContext to emit ---
  // NO_LANGUAGE_WARNING is always emitted when its error condition holds.
  // REMINDER and language-healing logic only run when shouldFire is true.
  let additionalContext = "";

  // Track whether we need to emit the language warning (independent of throttle).
  let needsLanguageWarning = false;

  if (shouldFire) {
    const existingLanguages = readLanguages(projectYmlPath);

    // Widen the heal condition: trigger a rewrite whenever the block is
    // corrupted (orphan lines detected by readLanguages), contains duplicates,
    // or contains invalid scalars (e.g. `markdown []` from Serena folding a
    // corrupt inline form into the block key).
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
        // REMINDER is sufficient — languages are now configured and cleaned.
      } else {
        // All entries were invalid — fall back to auto-detection.
        const detected = detectLanguages(repoRoot);
        if (detected.length > 0) {
          patchLanguages(projectYmlPath, detected);
          // REMINDER is sufficient — languages are now configured.
        } else {
          needsLanguageWarning = true;
        }
      }
    } else if (existingLanguages.length === 0) {
      // Languages not yet configured — attempt auto-detection.
      const detected = detectLanguages(repoRoot);
      if (detected.length > 0) {
        patchLanguages(projectYmlPath, detected);
        // REMINDER is sufficient — languages are now configured.
      } else {
        // Nothing detectable — surface a targeted warning.
        needsLanguageWarning = true;
      }
    }
    // If existingLanguages.length > 0 and no corruption/duplicates/invalid — fast path: emit normal REMINDER only.

    additionalContext = REMINDER;
    if (needsLanguageWarning) {
      additionalContext += NO_LANGUAGE_WARNING;
    }
  } else {
    // Throttled: do not emit REMINDER or heal, but still check whether
    // NO_LANGUAGE_WARNING is warranted.
    const existingLanguages = readLanguages(projectYmlPath);
    const uniqueLanguages = [...new Set(existingLanguages)];
    const hasInvalidEntries = uniqueLanguages.some(
      (e) => !isValidLanguageEntry(e)
    );
    const isDuplicated = uniqueLanguages.length !== existingLanguages.length;
    const isCorrupted = existingLanguages._corrupted === true;

    if (existingLanguages.length > 0 && (isDuplicated || isCorrupted || hasInvalidEntries)) {
      // Corrupted/invalid entries — check if any valid language remains.
      const cleanLanguages = uniqueLanguages.filter(isValidLanguageEntry);
      if (cleanLanguages.length === 0) {
        // All entries invalid — would need detection; warn if detection also fails.
        const detected = detectLanguages(repoRoot);
        if (detected.length === 0) {
          needsLanguageWarning = true;
        }
      }
      // If cleanLanguages.length > 0, languages are configured (just dirty) — no warning.
    } else if (existingLanguages.length === 0) {
      // No languages at all — warn if detection would also fail.
      const detected = detectLanguages(repoRoot);
      if (detected.length === 0) {
        needsLanguageWarning = true;
      }
    }
    // existingLanguages.length > 0 with no corruption — languages configured, no warning.

    if (needsLanguageWarning) {
      additionalContext = NO_LANGUAGE_WARNING;
    }
  }

  // Emit the PreToolUse hook output. This hook never makes a permission
  // decision — it only injects context (or, on the throttled path with
  // nothing to say, emits nothing at all). Claude Code's normal permission
  // flow for the tool call is left untouched either way.
  if (additionalContext === "") {
    process.exit(0);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext,
    },
  };

  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

// Export internal functions for testing. Guard main() so importing this module
// as an ES module does not run the hook.
export { readLanguages, patchLanguages, detectLanguages, sortLanguages, isValidLanguageEntry, readState, writeState, computeThrottle, resolveStateFilePath };

// Only run main() when this file is executed directly (not imported).
const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (err) {
    // Never block the tool call due to an unexpected error.
    process.stderr.write(
      `serena-reminder-hook: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
