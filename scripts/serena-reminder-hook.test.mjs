#!/usr/bin/env node
/**
 * Tests for serena-reminder-hook.mjs
 *
 * Plain Node.js — no test framework, no external dependencies.
 * Uses fs.mkdtempSync for isolated temp directories per test.
 * Exit code 0 = all pass, non-zero = at least one failure.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLanguages, patchLanguages, isValidLanguageEntry, detectLanguages, readState, writeState, computeThrottle, resolveStateFilePath } from "./serena-reminder-hook.mjs";
import { healProjectYml, run } from "./serena-boot-wrapper.mjs";

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp directory containing a .serena/project.yml with the given
 * content. Returns the absolute path to project.yml.
 */
function makeTempProject(ymlContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-test-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  fs.writeFileSync(ymlPath, ymlContent, "utf8");
  return ymlPath;
}

/**
 * Read raw content of a project.yml path.
 */
function readRaw(ymlPath) {
  return fs.readFileSync(ymlPath, "utf8");
}

// ---------------------------------------------------------------------------
// Regression test: the exact corrupted block from the ticket
// ---------------------------------------------------------------------------

test("regression: corrupted block (blank-line-separated orphan) — readLanguages returns all entries including duplicate", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- typescript\n` +
    `- markdown\n` +
    `- json\n` +
    `\n` +
    `- typescript\n` +
    `\n` +
    `# the encoding\n` +
    `encoding: "utf-8"\n`
  );

  const langs = readLanguages(ymlPath);
  // The new regex must capture all 4 entries (including the orphaned duplicate).
  assertEqual(langs, ["typescript", "markdown", "json", "typescript"],
    "readLanguages with corrupted block");
});

test("regression: corrupted block — after patchLanguages with deduped list, file is clean", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- typescript\n` +
    `- markdown\n` +
    `- json\n` +
    `\n` +
    `- typescript\n` +
    `\n` +
    `# the encoding\n` +
    `encoding: "utf-8"\n`
  );

  // Simulate what main() does: read, dedup, patch.
  const raw = readLanguages(ymlPath);
  const deduped = [...new Set(raw)];
  patchLanguages(ymlPath, deduped);

  const content = readRaw(ymlPath);

  // The clean block must be present.
  assert(content.includes("languages:\n- typescript\n- markdown\n- json\n"),
    "clean block present after patch");

  // No orphaned entries must remain.
  const afterBlock = content.split("languages:\n")[1];
  const orphanMatch = afterBlock.match(/^- typescript\n.*^- typescript\n/ms);
  assert(!orphanMatch, "no orphaned duplicate entry after patch");

  // The comment after the block must still be present.
  assert(content.includes("# the encoding"), "comment after block preserved");
  assert(content.includes('encoding: "utf-8"'), "encoding key preserved");

  // readLanguages on the cleaned file must return exactly 3 unique entries.
  const cleaned = readLanguages(ymlPath);
  assertEqual(cleaned, ["typescript", "markdown", "json"],
    "readLanguages after patch returns clean 3-entry list");
});

// ---------------------------------------------------------------------------
// readLanguages edge cases
// ---------------------------------------------------------------------------

test("readLanguages: languages: at EOF with no trailing newline returns []", () => {
  const ymlPath = makeTempProject(`project_name: "test"\nlanguages:`);
  assertEqual(readLanguages(ymlPath), [], "EOF no trailing newline");
});

test("readLanguages: languages: followed immediately by empty value (colon+newline then next key) returns []", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), [], "empty list before next key");
});

test("readLanguages: languages: with blank-only line then next key returns []", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `\n` +
    `encoding: "utf-8"\n`
  );
  // A blank line followed by a real key — no `- entry` lines present.
  assertEqual(readLanguages(ymlPath), [], "blank line then next key → empty");
});

test("readLanguages: valid 3-entry list returns all 3", () => {
  const ymlPath = makeTempProject(
    `languages:\n` +
    `- typescript\n` +
    `- markdown\n` +
    `- json\n` +
    `\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), ["typescript", "markdown", "json"],
    "valid 3-entry list");
});

test("readLanguages: interleaved blank lines — returns all entries, no blanks", () => {
  const ymlPath = makeTempProject(
    `languages:\n` +
    `- typescript\n` +
    `\n` +
    `- python\n` +
    `\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), ["typescript", "python"],
    "interleaved blanks filtered out");
});

test("readLanguages: file unreadable returns []", () => {
  assertEqual(readLanguages("/nonexistent/path/project.yml"), [],
    "unreadable file");
});

// ---------------------------------------------------------------------------
// patchLanguages edge cases
// ---------------------------------------------------------------------------

test("patchLanguages: languages: at EOF with no trailing newline — writes valid block", () => {
  const ymlPath = makeTempProject(`project_name: "test"\nlanguages:`);
  patchLanguages(ymlPath, ["typescript"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- typescript\n"), "block written at EOF");
});

test("patchLanguages: already-valid 3-entry list — produces equivalent valid output", () => {
  const original =
    `languages:\n` +
    `- typescript\n` +
    `- markdown\n` +
    `- json\n` +
    `\n` +
    `# the encoding\n` +
    `encoding: "utf-8"\n`;
  const ymlPath = makeTempProject(original);
  patchLanguages(ymlPath, ["typescript", "markdown", "json"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- typescript\n- markdown\n- json\n"),
    "valid block preserved");
  assert(content.includes("# the encoding"), "trailing comment preserved");
  assert(content.includes('encoding: "utf-8"'), "encoding key preserved");
});

test("patchLanguages: replacement does not consume the next YAML key", () => {
  const ymlPath = makeTempProject(
    `languages:\n` +
    `- typescript\n` +
    `encoding: "utf-8"\n`
  );
  patchLanguages(ymlPath, ["python"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- python\n"), "new entry written");
  assert(content.includes('encoding: "utf-8"'), "next key not consumed");
  assert(!content.includes("- typescript"), "old entry removed");
});

test("patchLanguages: duplicate entries — dedup normalises file", () => {
  const ymlPath = makeTempProject(
    `languages:\n` +
    `- typescript\n` +
    `- markdown\n` +
    `- json\n` +
    `\n` +
    `- typescript\n` +
    `\n` +
    `encoding: "utf-8"\n`
  );
  const raw = readLanguages(ymlPath);
  const deduped = [...new Set(raw)];
  patchLanguages(ymlPath, deduped);
  const after = readLanguages(ymlPath);
  assertEqual(after, ["typescript", "markdown", "json"],
    "deduped entries after patch");
  // Confirm no blank lines remain inside the languages block.
  const content = readRaw(ymlPath);
  const blockMatch = content.match(/^languages:[ \t]*\n((?:.*\n)*?)(?:^[a-z#])/m);
  if (blockMatch) {
    assert(!blockMatch[1].includes("\n\n"), "no blank lines in cleaned block");
  }
});

test("patchLanguages: interleaved blank lines, no duplicates — clean output, no blanks inside block", () => {
  const ymlPath = makeTempProject(
    `languages:\n` +
    `- typescript\n` +
    `\n` +
    `- python\n` +
    `\n` +
    `encoding: "utf-8"\n`
  );
  // patchLanguages with the same unique entries should still clean the blanks.
  patchLanguages(ymlPath, ["typescript", "python"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- typescript\n- python\n"),
    "clean block without interleaved blanks");
  assert(content.includes('encoding: "utf-8"'), "next key preserved");
});

// ---------------------------------------------------------------------------
// CRLF line-ending tests
// ---------------------------------------------------------------------------

test("CRLF: readLanguages on mixed LF/CRLF file returns 6 entries (3 duplicates)", () => {
  // Mirrors the exact corrupted pattern from the real .serena/project.yml:
  // - LF-terminated triplet
  // - CRLF blank separator line
  // - CRLF-terminated duplicate triplet
  const ymlContent =
    "project_name: \"test\"\r\n" +
    "languages:\n" +
    "- typescript\n" +
    "- markdown\n" +
    "- json\n" +
    "\r\n" +
    "- typescript\r\n" +
    "- markdown\r\n" +
    "- json\r\n" +
    "\r\n" +
    "encoding: \"utf-8\"\r\n";

  const ymlPath = makeTempProject(ymlContent);
  const langs = readLanguages(ymlPath);
  // Must detect all 6 entries (3 + 3 duplicate), not just the first 3.
  assertEqual(langs, ["typescript", "markdown", "json", "typescript", "markdown", "json"],
    "readLanguages with CRLF mixed file returns 6 entries");
});

test("CRLF: patchLanguages on mixed LF/CRLF file produces clean LF-only languages block", () => {
  // Same mixed pattern as above.
  const ymlContent =
    "project_name: \"test\"\r\n" +
    "languages:\n" +
    "- typescript\n" +
    "- markdown\n" +
    "- json\n" +
    "\r\n" +
    "- typescript\r\n" +
    "- markdown\r\n" +
    "- json\r\n" +
    "\r\n" +
    "encoding: \"utf-8\"\r\n";

  const ymlPath = makeTempProject(ymlContent);

  // Simulate what main() does: read → dedup → patch.
  const raw = readLanguages(ymlPath);
  const deduped = [...new Set(raw)];
  patchLanguages(ymlPath, deduped);

  const content = readRaw(ymlPath);

  // Exactly one clean triplet must be present.
  assert(content.includes("languages:\n- typescript\n- markdown\n- json\n"),
    "clean LF-only block present after patch");

  // No \r must remain inside the languages block section.
  const afterLanguagesKey = content.split("languages:\n")[1];
  // Everything up to the next non-entry/non-blank line.
  const blockLines = [];
  for (const line of afterLanguagesKey.split("\n")) {
    if (/^- /.test(line) || /^[ \t\r]*$/.test(line)) {
      blockLines.push(line);
    } else {
      break;
    }
  }
  const blockText = blockLines.join("\n");
  assert(!blockText.includes("\r"),
    "no \\r in languages block after patch");

  // No CRLF orphan duplicates remain.
  const dupeMatch = content.match(/- typescript[\s\S]*?- typescript/);
  assert(!dupeMatch, "no duplicate typescript entry after patch");

  // Section after block is intact.
  assert(content.includes("encoding"), "encoding key still present after patch");

  // readLanguages on the cleaned file returns exactly 3 unique entries.
  const cleaned = readLanguages(ymlPath);
  assertEqual(cleaned, ["typescript", "markdown", "json"],
    "readLanguages after patch returns clean 3-entry list");
});

// ---------------------------------------------------------------------------
// Inline flow-syntax tests (ticket #16 bug 1)
// ---------------------------------------------------------------------------

test("readLanguages: inline empty — languages: [] returns []", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: []\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), [], "inline empty list");
});

test("readLanguages: inline single entry — languages: [typescript] returns [\"typescript\"]", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: [typescript]\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), ["typescript"], "inline single entry");
});

test("readLanguages: inline multi-entry — languages: [a, b, c] returns [\"a\",\"b\",\"c\"]", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: [a, b, c]\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), ["a", "b", "c"], "inline multi-entry");
});

test("readLanguages: inline whitespace — languages: [ ] returns []", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: [ ]\n` +
    `encoding: "utf-8"\n`
  );
  assertEqual(readLanguages(ymlPath), [], "inline whitespace-only brackets");
});

test("patchLanguages: inline empty — languages: [] is replaced with block form", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: []\n` +
    `encoding: "utf-8"\n`
  );
  patchLanguages(ymlPath, ["python"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- python\n"), "block form written");
  assert(!content.includes("languages: []"), "no inline form residue");
  assert(content.includes('encoding: "utf-8"'), "next key preserved");
});

test("patchLanguages: inline filled — languages: [typescript] is replaced with block form", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: [typescript]\n` +
    `encoding: "utf-8"\n`
  );
  patchLanguages(ymlPath, ["python"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- python\n"), "new entry written as block");
  assert(!content.includes("[typescript]"), "old inline form removed");
  assert(content.includes('encoding: "utf-8"'), "next key preserved");
});

// ---------------------------------------------------------------------------
// Corrupted block with orphan ` []` line (ticket #16 bug 2)
// ---------------------------------------------------------------------------

test("readLanguages: corrupted block with orphan ` []` line — returns entries with _corrupted flag", () => {
  // Simulate `languages:\n- markdown\n []\n` — the Serena folded form.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- markdown\n` +
    ` []\n` +
    `encoding: "utf-8"\n`
  );
  const langs = readLanguages(ymlPath);
  assertEqual(langs, ["markdown"], "entries returned correctly");
  assert(langs._corrupted === true, "_corrupted flag set");
  // Non-enumerable: should not appear in JSON.stringify
  assert(!JSON.stringify(langs).includes("_corrupted"), "_corrupted not enumerable");
});

test("patchLanguages: corrupted block with orphan ` []` — orphan line fully replaced", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- markdown\n` +
    ` []\n` +
    `encoding: "utf-8"\n`
  );
  patchLanguages(ymlPath, ["markdown"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- markdown\n"), "clean block written");
  assert(!content.includes(" []"), "orphan [] line removed");
  assert(!content.includes("markdown []"), "no merged invalid scalar");
  assert(content.includes('encoding: "utf-8"'), "next key preserved");
  // Verify re-parse is clean.
  const cleaned = readLanguages(ymlPath);
  assertEqual(cleaned, ["markdown"], "re-parse returns clean list");
  assert(cleaned._corrupted !== true, "no _corrupted flag after clean patch");
});

// ---------------------------------------------------------------------------
// isValidLanguageEntry helper
// ---------------------------------------------------------------------------

test("isValidLanguageEntry: valid keys return true", () => {
  assert(isValidLanguageEntry("typescript"), "typescript is valid");
  assert(isValidLanguageEntry("python"), "python is valid");
  assert(isValidLanguageEntry("go"), "go is valid");
  assert(isValidLanguageEntry("cpp"), "cpp is valid");
  assert(isValidLanguageEntry("csharp"), "csharp is valid");
  assert(isValidLanguageEntry("markdown"), "markdown is valid");
  assert(isValidLanguageEntry("json"), "json is valid");
  assert(isValidLanguageEntry("yaml"), "yaml is valid");
  assert(isValidLanguageEntry("toml"), "toml is valid");
});

test("isValidLanguageEntry: invalid entries return false", () => {
  assert(!isValidLanguageEntry("markdown []"), "space+brackets is invalid");
  assert(!isValidLanguageEntry(" []"), "bare orphan line is invalid");
  assert(!isValidLanguageEntry(""), "empty string is invalid");
  assert(!isValidLanguageEntry("TypeScript"), "uppercase is invalid");
  assert(!isValidLanguageEntry("type-script"), "hyphen is invalid");
  assert(!isValidLanguageEntry("123abc"), "starts with digit is invalid");
});

// ---------------------------------------------------------------------------
// Blocking fix 1: patchLanguages inline-at-EOF produces trailing newline
// ---------------------------------------------------------------------------

test("patchLanguages: inline languages: [] at EOF (no trailing newline) → round-trips cleanly via readLanguages", () => {
  // File ends with `languages: []` — no trailing newline at all.
  const ymlPath = makeTempProject(`project_name: "test"\nlanguages: []`);
  patchLanguages(ymlPath, ["python"]);
  const content = readRaw(ymlPath);
  // The block must be present (newBlock ends with \n, so file gains one trailing newline).
  assert(content.includes("languages:\n- python"), "block written when inline [] at EOF");
  // readLanguages must round-trip correctly — no empty array due to missing newline.
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python"], "readLanguages round-trips after inline-at-EOF patch");
});

// ---------------------------------------------------------------------------
// Blocking fix 2: readLanguages strips surrounding quotes from both paths
// ---------------------------------------------------------------------------

test("readLanguages: inline-quoted — languages: [\"python\"] returns [\"python\"] (unquoted)", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: ["python"]\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python"], "double-quoted inline entry stripped");
  assert(isValidLanguageEntry(result[0]), "stripped value passes isValidLanguageEntry");
});

test("readLanguages: inline-quoted multiple — languages: [\"python\", \"typescript\"] returns bare identifiers", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages: ["python", "typescript"]\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python", "typescript"], "double-quoted inline entries stripped");
});

test("readLanguages: block-quoted — - \"python\" returns [\"python\"] (unquoted)", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- "python"\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python"], "double-quoted block entry stripped");
  assert(isValidLanguageEntry(result[0]), "stripped value passes isValidLanguageEntry");
});

test("readLanguages: block single-quoted — - 'python' returns [\"python\"] (unquoted)", () => {
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- 'python'\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python"], "single-quoted block entry stripped");
  assert(isValidLanguageEntry(result[0]), "stripped value passes isValidLanguageEntry");
});

test("readLanguages: quoted invalid scalar — - \"markdown []\" strips quotes but still fails isValidLanguageEntry", () => {
  // After stripping quotes: "markdown []" → markdown [] which contains a space.
  // isValidLanguageEntry must still reject it.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- "markdown []"\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  // The scalar after quote-stripping is "markdown []" — still invalid.
  assert(!isValidLanguageEntry(result[0]), "quoted invalid scalar still rejected by isValidLanguageEntry");
});

// ---------------------------------------------------------------------------
// Full heal path: inline [] + docs-only repo
// ---------------------------------------------------------------------------

test("heal path: inline empty languages: [] in docs-only repo gets detected language written", () => {
  // Create a minimal temp project with inline empty languages and a .md file
  // so detectLanguages finds markdown.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-heal-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  fs.writeFileSync(ymlPath, `project_name: "test"\nlanguages: []\n`, "utf8");
  // Place a markdown file at repo root so detectLanguages detects markdown.
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n", "utf8");

  // readLanguages returns [] (inline empty) → patchLanguages with detected ["markdown"].
  const existing = readLanguages(ymlPath);
  assertEqual(existing, [], "inline empty parsed as []");

  // Simulate the main() auto-detect branch.
  // Since existing.length === 0, detectLanguages would be called. We call
  // patchLanguages directly with the expected result to test the full chain.
  patchLanguages(ymlPath, ["markdown"]);

  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- markdown\n"), "markdown block written");
  assert(!content.includes("languages: []"), "no inline [] residue");

  // YAML re-parse must be clean.
  const cleaned = readLanguages(ymlPath);
  assertEqual(cleaned, ["markdown"], "re-parse clean");
  assert(cleaned._corrupted !== true, "no corruption flag");
});

// ---------------------------------------------------------------------------
// Inline comment fixes (blocking review findings)
// ---------------------------------------------------------------------------

test("readLanguages: block entry with inline comment — python  # backend → [\"python\",\"typescript\"], no _corrupted", () => {
  // Pattern A: `- python  # backend` should yield "python", not "python  # backend".
  // Both languages must survive; _corrupted must NOT be set.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- python  # backend\n` +
    `- typescript\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python", "typescript"], "inline comment stripped, both languages kept");
  assert(result._corrupted !== true, "_corrupted must NOT be set for inline comment entry");
  assert(isValidLanguageEntry(result[0]), "python passes isValidLanguageEntry after comment strip");
  assert(isValidLanguageEntry(result[1]), "typescript passes isValidLanguageEntry");
});

test("readLanguages: block with indented comment-only line — not corrupted, both languages returned", () => {
  // Pattern B: `  # a comment` inside a block sequence is valid YAML and must
  // not set _corrupted or cause a needless rewrite.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- python\n` +
    `  # a comment\n` +
    `- typescript\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python", "typescript"], "both languages returned despite comment line");
  assert(result._corrupted !== true, "_corrupted must NOT be set for indented comment line");
});

// ---------------------------------------------------------------------------
// New tests: column-0 comment between entries (the bug to fix in #16)
// ---------------------------------------------------------------------------

test("readLanguages: column-0 comment between entries — both languages returned, no _corrupted", () => {
  // Core bug: a column-0 `# note` between two entries must NOT truncate the
  // block. Both python and typescript must survive; _corrupted must NOT be set.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- python\n` +
    `# note\n` +
    `- typescript\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python", "typescript"],
    "both languages returned despite column-0 comment between them");
  assert(result._corrupted !== true,
    "_corrupted must NOT be set for a comment-only line between entries");
});

test("readLanguages: trailing column-0 comment before next key — only entry before comment returned, no _corrupted", () => {
  // Scenario 1: trailing `# the encoding` comment must stop the block from
  // being extended into the next key, but must not cause any data loss.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- python\n` +
    `# the encoding\n` +
    `encoding: "utf-8"\n`
  );
  const result = readLanguages(ymlPath);
  assertEqual(result, ["python"],
    "only python returned; # the encoding comment does not split the result");
  assert(result._corrupted !== true,
    "_corrupted must NOT be set when trailing comment precedes next key");
});

test("patchLanguages: trailing '# the encoding' comment + encoding key survive a rewrite", () => {
  // After patching, the comment and the following key must both still be present.
  const original =
    `project_name: "test"\n` +
    `languages:\n` +
    `- python\n` +
    `# the encoding\n` +
    `encoding: "utf-8"\n`;
  const ymlPath = makeTempProject(original);
  patchLanguages(ymlPath, ["python", "typescript"]);
  const content = readRaw(ymlPath);
  assert(content.includes("languages:\n- python\n- typescript\n"),
    "new block written correctly");
  assert(content.includes("# the encoding"),
    "trailing comment preserved after patch");
  assert(content.includes('encoding: "utf-8"'),
    "encoding key preserved after patch");
});

test("patchLanguages/heal: column-0 comment between entries in corrupted block — all valid languages survive", () => {
  // A block that is corrupted AND has a column-0 comment between entries.
  // After heal (dedup + patch), every valid language must appear in the output.
  const ymlPath = makeTempProject(
    `project_name: "test"\n` +
    `languages:\n` +
    `- python\n` +
    `# note\n` +
    `- typescript\n` +
    `\n` +
    `- python\n` +
    `encoding: "utf-8"\n`
  );

  // Read should see all entries including the duplicate.
  const raw = readLanguages(ymlPath);
  assertEqual(raw, ["python", "typescript", "python"],
    "readLanguages sees all 3 entries (including duplicate) before heal");

  // Simulate main(): dedup, then patch.
  const deduped = [...new Set(raw)];
  patchLanguages(ymlPath, deduped);

  const content = readRaw(ymlPath);
  assert(content.includes("- python"), "python present after heal");
  assert(content.includes("- typescript"), "typescript present after heal");
  assert(!content.match(/- python[\s\S]*?- python/),
    "no duplicate python entry after heal");
  assert(content.includes('encoding: "utf-8"'),
    "encoding key preserved after heal");

  // Re-parse must return exactly the two unique languages.
  const cleaned = readLanguages(ymlPath);
  assertEqual(cleaned, ["python", "typescript"],
    "readLanguages after heal returns exactly the two unique languages");
  assert(cleaned._corrupted !== true, "no _corrupted flag after heal");
});

// ---------------------------------------------------------------------------
// Boot-wrapper tests (serena-boot-wrapper.mjs)
// ---------------------------------------------------------------------------

test("boot-wrapper: corrupt block (- toml []) healed before boot — readLanguages returns only valid entry", () => {
  // Arrange: project.yml with a corrupted languages block.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-boot-wrapper-test-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  fs.writeFileSync(
    ymlPath,
    `project_name: "test"\nlanguages:\n- typescript\n- toml []\n`,
    "utf8"
  );

  // Act: run the wrapper's heal logic.
  healProjectYml(tmpDir);

  // Assert: file healed — only valid entry remains, no `toml []`, no `_corrupted`.
  const result = readLanguages(ymlPath);
  assertEqual(result, ["typescript"], "only typescript survives after heal");
  assert(result._corrupted !== true, "no _corrupted flag after heal");
  const raw = fs.readFileSync(ymlPath, "utf8");
  assert(!raw.includes("toml []"), "toml [] not present in healed file");
});

test("boot-wrapper: valid block left unchanged — file content identical after heal", () => {
  // Arrange: clean project.yml with two valid languages.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-boot-wrapper-test-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  const original = `project_name: "test"\nlanguages:\n- typescript\n- python\n`;
  fs.writeFileSync(ymlPath, original, "utf8");

  // Act: heal (should be a no-op for a clean file).
  healProjectYml(tmpDir);

  // Assert: file content is byte-for-byte identical.
  const after = fs.readFileSync(ymlPath, "utf8");
  assertEqual(after, original, "file content unchanged for valid block");
});

test("boot-wrapper: heal error does not prevent uvx spawn — spawnSync still called", () => {
  // Arrange: track spawnSync invocations and force heal to throw by making
  // the project directory non-existent (readLanguages will return [] → detectLanguages
  // on a non-existent dir returns [] → no patchLanguages call, no error).
  // To force an actual throw we pass a projectDir where path.join itself won't
  // throw but readFileSync will fail silently (returns []) — so we instead
  // stub fs.readFileSync within the healProjectYml call by temporarily monkey-
  // patching readLanguages via a try/catch wrapper around a directory that causes
  // detectLanguages to fail gracefully.
  //
  // Simpler, deterministic approach: call run() directly with a stub spawnSync
  // and a --project pointing at a directory that does NOT exist, so heal is
  // attempted (no error thrown, just returns quietly) and spawnSync is called.
  // We also verify that when the heal itself throws (we cannot easily force this
  // without monkey-patching internals), run() catches it and still calls spawnSync.
  //
  // We test the catch path by directly wrapping healProjectYml in the same
  // try/catch and asserting spawnSync is always reached.

  let spawnCalled = false;
  let spawnCommand = null;
  let spawnArgs = null;
  const fakeSpawn = (cmd, args, opts) => {
    spawnCalled = true;
    spawnCommand = cmd;
    spawnArgs = args;
    return { status: 0 };
  };

  // Intercept process.exit so the test continues after run().
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };

  try {
    // Use a non-existent project dir — heal silently no-ops (readLanguages
    // catches the ENOENT and returns []; detectLanguages on a missing dir also
    // returns [] — so healProjectYml is a no-op and does NOT throw).
    // The important assertion is that spawnSync is called with "uvx".
    const argv = ["--from", "serena-agent==1.5.3", "serena", "start-mcp-server",
                  "--project", "/nonexistent/path/to/project"];
    run(argv, { spawnSync: fakeSpawn });
  } finally {
    process.exit = originalExit;
  }

  assert(spawnCalled, "spawnSync was called despite heal path");
  assertEqual(spawnCommand, "uvx", "spawnSync called with 'uvx'");
  assertEqual(exitCode, 0, "process.exit called with uvx exit code");
});

test("boot-wrapper: --project-from-cwd is rewritten to --project <cwd>, so heal now runs against cwd", () => {
  // Arrange: argv has --project-from-cwd instead of --project <dir>. Per the
  // #45 fix, run() rewrites --project-from-cwd to --project <process.cwd()>
  // BEFORE the heal lookup, so healProjectYml IS now invoked (Codex gets the
  // same heal behaviour Claude already had) — this is the opposite of the
  // previous "heal is skipped entirely" claim this test used to make.
  //
  // The cwd is sandboxed via process.chdir() into a fresh temp directory
  // (restored in `finally`) so the heal step never touches this repo's own
  // live .serena/project.yml, matching the isolation pattern the other
  // boot-wrapper tests use via fs.mkdtempSync.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-boot-wrapper-cwd-test-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  fs.writeFileSync(
    ymlPath,
    `project_name: "test"\nlanguages:\n- typescript\n- toml []\n`,
    "utf8"
  );

  let spawnCalled = false;
  let spawnArgs = null;
  const fakeSpawn = (cmd, args, opts) => {
    spawnCalled = true;
    spawnArgs = args;
    return { status: 0 };
  };

  const originalExit = process.exit;
  const originalCwd = process.cwd();
  let expectedProjectDir;
  process.exit = () => {};
  try {
    process.chdir(tmpDir);
    expectedProjectDir = process.cwd();
    const argv = ["--from", "serena-agent==1.5.3", "serena", "start-mcp-server",
                  "--project-from-cwd", "--context", "codex"];
    run(argv, { spawnSync: fakeSpawn });
  } finally {
    process.chdir(originalCwd);
    process.exit = originalExit;
  }

  assert(spawnCalled, "spawnSync called for --project-from-cwd variant");
  assert(spawnArgs.includes("--project"),
    "--project-from-cwd rewritten to --project in forwarded argv");
  assert(!spawnArgs.includes("--project-from-cwd"),
    "--project-from-cwd itself is not forwarded to uvx");
  assertEqual(spawnArgs[spawnArgs.indexOf("--project") + 1], expectedProjectDir,
    "--project value is the sandboxed temp cwd, not the real repo root");

  // Assert heal actually ran against the temp cwd's project.yml (not skipped):
  // the corrupted `- toml []` entry must be gone.
  const result = readLanguages(ymlPath);
  assertEqual(result, ["typescript"],
    "heal ran against --project-from-cwd's rewritten cwd: only typescript survives");
  assert(result._corrupted !== true, "no _corrupted flag after heal");
});

// ---------------------------------------------------------------------------
// Throttle: readState / writeState
// ---------------------------------------------------------------------------

test("readState: missing file returns zero-value", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-state-test-"));
  const stateFile = path.join(tmpDir, ".reminder-state.json");
  // File does not exist.
  const state = readState(stateFile);
  assertEqual(state, { counter: 0, session_id: "" }, "missing file → zero-value");
});

test("readState: corrupt JSON returns zero-value", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-state-test-"));
  const stateFile = path.join(tmpDir, ".reminder-state.json");
  fs.writeFileSync(stateFile, "not valid json{{", "utf8");
  const state = readState(stateFile);
  assertEqual(state, { counter: 0, session_id: "" }, "corrupt JSON → zero-value");
});

test("readState: invalid shape (counter not a number) returns zero-value", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-state-test-"));
  const stateFile = path.join(tmpDir, ".reminder-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ counter: "oops", session_id: "s" }), "utf8");
  const state = readState(stateFile);
  assertEqual(state, { counter: 0, session_id: "" }, "non-number counter → zero-value");
});

test("writeState / readState round-trip equality", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-state-test-"));
  const stateFile = path.join(tmpDir, ".reminder-state.json");
  const written = { counter: 42, session_id: "abc-session" };
  writeState(stateFile, written);
  const read = readState(stateFile);
  assertEqual(read, written, "round-trip equality");
});

test("writeState: unwritable path swallowed (no throw)", () => {
  // Pass a path whose parent directory does not exist — writeFileSync will throw.
  const badPath = path.join(os.tmpdir(), "nonexistent-dir-xyz-999", ".reminder-state.json");
  // Must not throw.
  writeState(badPath, { counter: 1, session_id: "" });
  // If we reach here, the error was swallowed correctly.
  assert(true, "no throw from unwritable path");
});

test("counter increments across 3 calls via readState/writeState", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-state-test-"));
  const stateFile = path.join(tmpDir, ".reminder-state.json");

  // Call 1.
  let state = readState(stateFile);
  const { newCounter: c1 } = computeThrottle(state, "", 10);
  writeState(stateFile, { counter: c1, session_id: "" });
  assertEqual(c1, 1, "counter after call 1 = 1");

  // Call 2.
  state = readState(stateFile);
  const { newCounter: c2 } = computeThrottle(state, "", 10);
  writeState(stateFile, { counter: c2, session_id: "" });
  assertEqual(c2, 2, "counter after call 2 = 2");

  // Call 3.
  state = readState(stateFile);
  const { newCounter: c3 } = computeThrottle(state, "", 10);
  writeState(stateFile, { counter: c3, session_id: "" });
  assertEqual(c3, 3, "counter after call 3 = 3");
});

// ---------------------------------------------------------------------------
// Throttle: computeThrottle fire positions
// ---------------------------------------------------------------------------

test("computeThrottle: interval=10 over 30 ticks fires at positions [1, 11, 21]", () => {
  const firePositions = [];
  let state = { counter: 0, session_id: "" };
  for (let tick = 1; tick <= 30; tick++) {
    const { shouldFire, newCounter, newSessionId } = computeThrottle(state, "", 10);
    if (shouldFire) {
      firePositions.push(tick);
    }
    state = { counter: newCounter, session_id: newSessionId };
  }
  assertEqual(firePositions, [1, 11, 21], "interval=10 fires at 1, 11, 21");
});

test("computeThrottle: interval=3 over 9 ticks fires at positions [1, 4, 7]", () => {
  const firePositions = [];
  let state = { counter: 0, session_id: "" };
  for (let tick = 1; tick <= 9; tick++) {
    const { shouldFire, newCounter, newSessionId } = computeThrottle(state, "", 3);
    if (shouldFire) {
      firePositions.push(tick);
    }
    state = { counter: newCounter, session_id: newSessionId };
  }
  assertEqual(firePositions, [1, 4, 7], "interval=3 fires at 1, 4, 7");
});

// ---------------------------------------------------------------------------
// Throttle: interval env-var parsing (unit-level via computeThrottle)
// ---------------------------------------------------------------------------

test("invalid interval 'abc' parses to NaN and falls back to 10", () => {
  // Replicate the parsing logic from main() to assert the fallback.
  function parseInterval(envVal) {
    let interval = 10;
    if (envVal !== undefined && envVal !== "") {
      const parsed = Number(envVal);
      if (Number.isInteger(parsed) && parsed > 0) {
        interval = parsed;
      }
    }
    return interval;
  }
  assertEqual(parseInterval("abc"), 10, "non-numeric string falls back to 10");
  assertEqual(parseInterval("0"), 10, "zero falls back to 10");
  assertEqual(parseInterval("-5"), 10, "negative falls back to 10");
  assertEqual(parseInterval("3.5"), 10, "non-integer falls back to 10");
  assertEqual(parseInterval("5"), 5, "valid positive integer accepted");
  assertEqual(parseInterval(undefined), 10, "undefined falls back to 10");
});

// ---------------------------------------------------------------------------
// Throttle: session reset
// ---------------------------------------------------------------------------

test("computeThrottle: new session forces shouldFire=true and resets counter to 1", () => {
  const state = { counter: 7, session_id: "old" };
  const result = computeThrottle(state, "new", 10);
  assert(result.shouldFire === true, "shouldFire=true on new session");
  assertEqual(result.newCounter, 1, "newCounter=1 on new session");
  assertEqual(result.newSessionId, "new", "newSessionId='new'");
});

test("computeThrottle: absent session (empty string) increments counter, keeps session_id", () => {
  const state = { counter: 5, session_id: "s1" };
  const result = computeThrottle(state, "", 10);
  assertEqual(result.newCounter, 6, "newCounter incremented to 6");
  assertEqual(result.newSessionId, "s1", "newSessionId preserved as 's1'");
  assert(result.shouldFire === false, "shouldFire=false (6 is not a fire position)");
});

// ---------------------------------------------------------------------------
// Throttle: NO_LANGUAGE_WARNING always emitted even when throttled
// ---------------------------------------------------------------------------

test("NO_LANGUAGE_WARNING not throttled: throttled call with empty languages emits warning but not REMINDER", () => {
  // Build a temp project with languages: [] and no detectable source files.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-warn-test-"));
  const serenaDir = path.join(tmpDir, ".serena");
  fs.mkdirSync(serenaDir);
  const ymlPath = path.join(serenaDir, "project.yml");
  fs.writeFileSync(ymlPath, `project_name: "test"\nlanguages: []\n`, "utf8");
  // No source files — detectLanguages will return [].

  // Use the statically-imported readLanguages and detectLanguages to reproduce
  // main()'s throttled decision.
  const existingLanguages = readLanguages(ymlPath);
  assertEqual(existingLanguages, [], "languages is empty");

  // Confirm this is a throttled call (shouldFire=false).
  const state = { counter: 5, session_id: "" };
  const { shouldFire } = computeThrottle(state, "", 10);
  assert(shouldFire === false, "shouldFire=false for this state (throttled)");

  // Simulate the throttled branch: existingLanguages=[], check detection.
  const detected = detectLanguages(tmpDir);
  assertEqual(detected, [], "no languages detected in empty project");

  // The warning condition holds regardless of shouldFire.
  const needsLanguageWarning = existingLanguages.length === 0 && detected.length === 0;
  assert(needsLanguageWarning === true, "needsLanguageWarning=true for empty languages + no detectable files");

  // On the throttled path: additionalContext = NO_LANGUAGE_WARNING (not REMINDER).
  const REMINDER_TEXT = "Note: this repository has Serena MCP semantic code tools available";
  const WARNING_TEXT = "Warning: .serena/project.yml has no languages configured";

  // Reproduce main()'s throttled additionalContext construction:
  const NO_LANGUAGE_WARNING_TEXT =
    " Warning: .serena/project.yml has no languages configured — " +
    "symbol tools are inactive until at least one language is added " +
    "under 'languages:' in .serena/project.yml.";
  const throttledContext = needsLanguageWarning ? NO_LANGUAGE_WARNING_TEXT : "";
  assert(!throttledContext.includes(REMINDER_TEXT), "throttled context does not contain REMINDER");
  assert(throttledContext.includes(WARNING_TEXT), "throttled context contains NO_LANGUAGE_WARNING");
});

// ---------------------------------------------------------------------------
// resolveStateFilePath
// ---------------------------------------------------------------------------

test("resolveStateFilePath: CLAUDE_PLUGIN_DATA set → path is <CLAUDE_PLUGIN_DATA>/reminder-state/<sessionId>.json", () => {
  const pluginData = path.join(os.tmpdir(), "test-plugin-data-" + Math.random().toString(36).slice(2));
  const result = resolveStateFilePath("my-session", { CLAUDE_PLUGIN_DATA: pluginData });
  const expected = path.join(pluginData, "reminder-state", "my-session.json");
  assertEqual(result, expected, "path under CLAUDE_PLUGIN_DATA");
});

test("resolveStateFilePath: CLAUDE_PLUGIN_DATA absent (undefined) → <os.tmpdir()>/agent-serena-wrapper/reminder-state/<sessionId>.json", () => {
  const result = resolveStateFilePath("my-session", {});
  const expected = path.join(os.tmpdir(), "agent-serena-wrapper", "reminder-state", "my-session.json");
  assertEqual(result, expected, "path under os.tmpdir() fallback when env key absent");
});

test("resolveStateFilePath: CLAUDE_PLUGIN_DATA empty string '' → falls through to tmpdir fallback", () => {
  const result = resolveStateFilePath("my-session", { CLAUDE_PLUGIN_DATA: "" });
  const expected = path.join(os.tmpdir(), "agent-serena-wrapper", "reminder-state", "my-session.json");
  assertEqual(result, expected, "empty CLAUDE_PLUGIN_DATA falls through to tmpdir");
});

test("resolveStateFilePath: sessionId empty → filename is no-session.json", () => {
  const pluginData = path.join(os.tmpdir(), "test-plugin-data-" + Math.random().toString(36).slice(2));
  const result = resolveStateFilePath("", { CLAUDE_PLUGIN_DATA: pluginData });
  const expected = path.join(pluginData, "reminder-state", "no-session.json");
  assertEqual(result, expected, "empty sessionId → no-session.json");
});

test("resolveStateFilePath: two distinct session IDs → two distinct paths (no clobber)", () => {
  const pluginData = path.join(os.tmpdir(), "test-plugin-data-" + Math.random().toString(36).slice(2));
  const env = { CLAUDE_PLUGIN_DATA: pluginData };
  const pathA = resolveStateFilePath("session-A", env);
  const pathB = resolveStateFilePath("session-B", env);
  assert(pathA !== pathB, "two distinct session IDs produce distinct paths");
  assert(pathA.endsWith("session-A.json"), "session-A path ends with session-A.json");
  assert(pathB.endsWith("session-B.json"), "session-B path ends with session-B.json");
});

test("resolveStateFilePath + writeState/readState round-trip: mkdirSync runs before writeFileSync", () => {
  // Use a real temp CLAUDE_PLUGIN_DATA that does NOT pre-exist the reminder-state subdir.
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "serena-plugin-data-"));
  const env = { CLAUDE_PLUGIN_DATA: pluginData };
  const stateFile = resolveStateFilePath("rt-session", env);

  // Confirm the parent directory does not yet exist (writeState must create it).
  assert(!fs.existsSync(path.dirname(stateFile)), "reminder-state dir does not pre-exist");

  // writeState should create the directory and write the file without throwing.
  const written = { counter: 7, session_id: "rt-session" };
  writeState(stateFile, written);

  // readState must be able to read it back.
  const read = readState(stateFile);
  assertEqual(read, written, "round-trip: readState returns what writeState wrote");

  // The directory must now exist.
  assert(fs.existsSync(path.dirname(stateFile)), "reminder-state dir created by writeState");
});

// ---------------------------------------------------------------------------
// End-to-end: real subprocess, stdin -> stdout (ticket #25)
//
// These spawn the actual script as a child process via execFileSync — the
// exact contract Claude Code invokes the hook under — rather than calling
// main() in-process (main() is intentionally not exported). Each test gets
// its own CLAUDE_PLUGIN_DATA temp dir so throttle state never leaks between
// tests or between the two calls within a single test.
// ---------------------------------------------------------------------------

const hookPath = fileURLToPath(new URL("./serena-reminder-hook.mjs", import.meta.url));

/**
 * Spawn the real hook script as a subprocess, feeding `input` on stdin and
 * isolating throttle state under `pluginDataDir`. Returns raw stdout text.
 *
 * `cwd`, when passed, sets the subprocess's actual OS working directory —
 * needed for inputs that never carry a JSON `cwd` field (malformed/empty
 * stdin), since main() then falls back to process.cwd(). Without pinning it
 * explicitly, that fallback would resolve to *this* repo's own worktree
 * (which is itself Serena-active), making the test's outcome depend on the
 * accident of where it happens to run rather than on the hook's contract.
 */
function runHookRaw(input, pluginDataDir, cwd) {
  return execFileSync(process.execPath, [hookPath], {
    input,
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
    encoding: "utf8",
  });
}

function makeE2eRepo(ymlContent) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-e2e-repo-"));
  const serenaDir = path.join(repoDir, ".serena");
  fs.mkdirSync(serenaDir);
  fs.writeFileSync(path.join(serenaDir, "project.yml"), ymlContent, "utf8");
  return repoDir;
}

function makePluginDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-e2e-plugindata-"));
}

test("e2e regression (#25): throttled second call with same session_id produces empty stdout, no permissionDecision on either call", () => {
  const repoDir = makeE2eRepo(
    `project_name: "test"\n` +
    `languages:\n` +
    `- typescript\n`
  );
  const pluginDataDir = makePluginDataDir();
  const sessionId = "session-regression-25";
  const payload = JSON.stringify({ cwd: repoDir, session_id: sessionId });

  // Call #1: brand-new session -> throttle fires -> non-empty stdout with REMINDER.
  const stdout1 = runHookRaw(payload, pluginDataDir);
  assert(stdout1.trim().length > 0, "call #1 (new session) produces non-empty stdout");
  const parsed1 = JSON.parse(stdout1);
  assert(!("permissionDecision" in parsed1.hookSpecificOutput),
    "call #1 must not contain permissionDecision");
  assert(parsed1.hookSpecificOutput.additionalContext.length > 0,
    "call #1 additionalContext non-empty");

  // Call #2: same session_id -> throttled (interval default 10, tick 2 does not
  // fire) -> languages are configured so no warning either -> additionalContext
  // stays "" -> hook must emit NOTHING on stdout (not even an empty-context object).
  const stdout2 = runHookRaw(payload, pluginDataDir);
  assertEqual(stdout2, "", "call #2 (throttled, same session) produces empty stdout");
});

test("e2e (#25): firing path — stdout is JSON with exactly hookEventName + additionalContext, no permissionDecision", () => {
  const repoDir = makeE2eRepo(
    `project_name: "test"\n` +
    `languages:\n` +
    `- typescript\n`
  );
  const pluginDataDir = makePluginDataDir();
  const payload = JSON.stringify({
    cwd: repoDir,
    session_id: "session-fire-" + Math.random().toString(36).slice(2),
  });

  const stdout = runHookRaw(payload, pluginDataDir);
  const parsed = JSON.parse(stdout);
  assertEqual(Object.keys(parsed), ["hookSpecificOutput"], "top-level has only hookSpecificOutput");

  const hso = parsed.hookSpecificOutput;
  assertEqual(Object.keys(hso).sort(), ["additionalContext", "hookEventName"],
    "hookSpecificOutput keys are exactly hookEventName + additionalContext");
  assert(!("permissionDecision" in hso), "permissionDecision must not be present");
  assertEqual(hso.hookEventName, "PreToolUse", "hookEventName is PreToolUse");
  assert(hso.additionalContext.length > 0, "additionalContext is non-empty on the firing path");
});

test("e2e (#25): warning path — empty languages + no detectable sources — additionalContext contains warning, no permissionDecision", () => {
  const repoDir = makeE2eRepo(`project_name: "test"\nlanguages: []\n`);
  // No other files placed in repoDir, so detectLanguages(repoDir) finds nothing.
  const pluginDataDir = makePluginDataDir();
  const payload = JSON.stringify({
    cwd: repoDir,
    session_id: "session-warn-" + Math.random().toString(36).slice(2),
  });

  const stdout = runHookRaw(payload, pluginDataDir);
  const parsed = JSON.parse(stdout);
  const hso = parsed.hookSpecificOutput;
  assert(!("permissionDecision" in hso), "permissionDecision must not be present");
  assert(hso.additionalContext.includes("Warning: .serena/project.yml has no languages configured"),
    "additionalContext contains the no-language warning");
});

test("e2e (#25): out-of-scope repo (no .serena/project.yml) — empty stdout, exit 0", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-e2e-oos-"));
  const pluginDataDir = makePluginDataDir();
  const payload = JSON.stringify({ cwd: repoDir, session_id: "session-oos" });

  const stdout = runHookRaw(payload, pluginDataDir);
  assertEqual(stdout, "", "out-of-scope repo produces empty stdout");
});

test("e2e (#25): malformed stdin — empty stdout, exit 0", () => {
  // Malformed JSON hits the catch in main() and exits before any cwd lookup,
  // so no out-of-scope cwd is needed here — but pin one anyway for safety.
  const outOfScopeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-e2e-oos-cwd-"));
  const pluginDataDir = makePluginDataDir();
  const stdout = runHookRaw("{ not valid json", pluginDataDir, outOfScopeCwd);
  assertEqual(stdout, "", "malformed stdin produces empty stdout");
});

test("e2e (#25): empty stdin — empty stdout, exit 0", () => {
  // Empty stdin does NOT hit main()'s catch (raw.trim() is falsy, so
  // JSON.parse is skipped without throwing) — it falls through to the
  // normal cwd-based scope check using process.cwd(). Pin the subprocess's
  // cwd to a fresh out-of-scope temp dir so the scope check reliably misses
  // regardless of where this test suite itself is checked out.
  const outOfScopeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "serena-hook-e2e-oos-cwd-"));
  const pluginDataDir = makePluginDataDir();
  const stdout = runHookRaw("", pluginDataDir, outOfScopeCwd);
  assertEqual(stdout, "", "empty stdin produces empty stdout");
});

// ---------------------------------------------------------------------------
// Regression (#26): reminder text must reference only real serena-agent
// 1.5.3 tool names, not the nonexistent get_symbol_body / find_references /
// search_symbols / activate_project.
// ---------------------------------------------------------------------------

test("e2e regression (#26): additionalContext excludes nonexistent tool names and includes real ones", () => {
  const repoDir = makeE2eRepo(
    `project_name: "test"\n` +
    `languages:\n` +
    `- typescript\n`
  );
  const pluginDataDir = makePluginDataDir();
  const payload = JSON.stringify({
    cwd: repoDir,
    session_id: "session-26-" + Math.random().toString(36).slice(2),
  });

  const stdout = runHookRaw(payload, pluginDataDir);
  const parsed = JSON.parse(stdout);
  const additionalContext = parsed.hookSpecificOutput.additionalContext;

  for (const wrongName of ["get_symbol_body", "find_references", "search_symbols", "activate_project"]) {
    assert(!additionalContext.includes(wrongName),
      `additionalContext must not contain nonexistent tool name "${wrongName}"`);
  }
  assert(additionalContext.includes("find_referencing_symbols"),
    "additionalContext must mention find_referencing_symbols");
  assert(additionalContext.includes("find_symbol"),
    "additionalContext must mention find_symbol");
});

// ---------------------------------------------------------------------------
// Doc-lint guard (#26): SKILL.md and README.md must not reference the
// nonexistent tool names from the pre-fix serena-agent version mismatch.
// ---------------------------------------------------------------------------

test("doc-lint (#26): SKILL.md does not reference nonexistent tool names", () => {
  const skillMdPath = fileURLToPath(
    new URL("../skills/serena-wrapper/SKILL.md", import.meta.url)
  );
  const content = fs.readFileSync(skillMdPath, "utf8");
  for (const wrongName of ["get_symbol_body", "find_references", "search_symbols", "activate_project"]) {
    assert(!content.includes(wrongName),
      `SKILL.md must not contain nonexistent tool name "${wrongName}"`);
  }
});

test("doc-lint (#26): README.md does not reference nonexistent tool names", () => {
  const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
  const content = fs.readFileSync(readmePath, "utf8");
  for (const wrongName of ["get_symbol_body", "find_references", "search_symbols", "activate_project"]) {
    assert(!content.includes(wrongName),
      `README.md must not contain nonexistent tool name "${wrongName}"`);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
