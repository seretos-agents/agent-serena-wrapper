#!/usr/bin/env node
/**
 * codex-manifest.test.mjs — regression guard for ticket #38.
 *
 * Resolves and executes the Codex manifest's MCP launch argv using only the
 * variables Codex provides (PLUGIN_ROOT), and checks the boot wrapper reports
 * a failed spawn instead of exiting silently.
 *
 * #45: also runs the real wrapper as a child process, with a `uvx` stub
 * placed first on PATH that records the argv it received, to prove
 * `--project-from-cwd` is rewritten to `--project <cwd>` before it ever
 * reaches uvx (Serena 1.5.3 walks ancestors for `.serena/project.yml` before
 * `.git` under `--project-from-cwd`, so a nested workspace under a directory
 * with its own project.yml would otherwise activate the ancestor's project).
 *
 * Run: node scripts/codex-manifest.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "./serena-boot-wrapper.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, dir, "plugin.json"), "utf8"));
}

/** Substitute ${NAME} using only the given variable map (others stay as-is). */
function substitute(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (m, name) => (name in vars ? vars[name] : m));
}

// ---------------------------------------------------------------------------
// R1 — Codex argv resolves with only Codex's variables
// ---------------------------------------------------------------------------

test("codex manifest: args[0] is ${PLUGIN_ROOT}/scripts/serena-boot-wrapper.mjs and node loads it cleanly", () => {
  const server = readManifest(".codex-plugin").mcpServers.serena;
  assertEqual(server.command, "node", "command");
  assertEqual(
    server.args[0],
    "${PLUGIN_ROOT}/scripts/serena-boot-wrapper.mjs",
    "args[0]"
  );

  const args = server.args.map((a) => substitute(a, { PLUGIN_ROOT: repoRoot }));
  for (const a of args) {
    assert(!a.includes("${"), `unsubstituted placeholder left in arg: ${a}`);
  }
  assert(fs.existsSync(args[0]), `args[0] does not exist on disk: ${args[0]}`);

  // Launch the manifest's declared command itself (not process.execPath), so a
  // placeholder or unresolvable command fails the launch. PATH holds only
  // node's own directory (minus any uvx), so nothing is downloaded/started.
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-manifest-test-"));
  const nodeName = path.basename(process.execPath);
  fs.copyFileSync(process.execPath, path.join(nodeDir, nodeName));
  const env = { ...process.env, PATH: nodeDir, Path: nodeDir };
  const result = spawnSync(server.command, args, { env, encoding: "utf8", timeout: 30000 });
  assert(!result.error, `could not launch declared command ${JSON.stringify(server.command)}: ${result.error?.message}`);
  const stderr = result.stderr ?? "";
  assert(
    !/Cannot find module|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/.test(stderr),
    `node failed to load the launch script: ${stderr.split("\n")[0]}`
  );
  // MCP stdio: stdout carries the protocol; the wrapper must not pollute it.
  assertEqual(result.stdout ?? "", "", "stdout of the spawned wrapper");
});

// ---------------------------------------------------------------------------
// R3 — spawn failure is reported, not silent
// ---------------------------------------------------------------------------

function captureRun(argv, spawnResult) {
  const origExit = process.exit;
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  let exitCode = null;
  let stderr = "";
  let stdout = "";
  process.exit = (code) => { exitCode = code; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  try {
    run(argv, { spawnSync: () => spawnResult });
  } finally {
    process.exit = origExit;
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  return { exitCode, stderr, stdout };
}

test("boot-wrapper: spawn error is reported on stderr (with the error text), stdout empty, exit code 1", () => {
  const { exitCode, stderr, stdout } = captureRun(["--project-from-cwd"], {
    error: new Error("spawn uvx ENOENT-xyz"),
    status: null,
  });
  assert(stderr.includes("uvx"), `stderr does not mention uvx: ${JSON.stringify(stderr)}`);
  assert(
    stderr.includes("ENOENT-xyz"),
    `stderr does not include the spawn error text: ${JSON.stringify(stderr)}`
  );
  assertEqual(stdout, "", "stdout");
  assertEqual(exitCode, 1, "exit code");
});

test("boot-wrapper: successful spawn writes nothing to stderr/stdout and exits 0", () => {
  const { exitCode, stderr, stdout } = captureRun(["--project-from-cwd"], { status: 0 });
  assertEqual(stderr, "", "stderr");
  assertEqual(stdout, "", "stdout");
  assertEqual(exitCode, 0, "exit code");
});

// ---------------------------------------------------------------------------
// #45 — codex --project-from-cwd rewritten to --project <cwd> before uvx
// ---------------------------------------------------------------------------
// R1-R3 run the real wrapper as a child process (via `process.execPath`, not
// an injected/mocked spawnSync) with a `uvx` stub placed first on PATH that
// records the argv it actually received. `captureRun` above stays unchanged
// and serves only the R4 spawn-error/success tests.

/**
 * Build a `uvx` stub, once per test run, that a real `spawnSync("uvx", ...,
 * {shell:false})` can resolve from PATH and that records the argv it was
 * called with to `UVX_STUB_LOG`.
 *
 * On win32, spawnSync with shell:false only resolves `uvx.com`/`uvx.exe`
 * (Node does not run `.cmd` shims without a shell), so the stub is compiled
 * as a tiny real .exe via the .NET Framework's csc.exe. On POSIX it is a
 * `#!/bin/sh` script.
 */
function makeUvxStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvx-stub-"));
  const log = path.join(dir, "uvx-stub.log");
  if (process.platform === "win32") {
    const csc = path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    );
    assert(fs.existsSync(csc), `csc.exe not found at ${csc} — cannot build the uvx PATH stub`);
    const srcPath = path.join(dir, "uvx-stub.cs");
    const exePath = path.join(dir, "uvx.exe");
    fs.writeFileSync(
      srcPath,
      [
        "using System;",
        "using System.IO;",
        "class UvxStub {",
        "  static void Main(string[] args) {",
        '    var log = Environment.GetEnvironmentVariable("UVX_STUB_LOG");',
        "    File.WriteAllLines(log, args);",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const compile = spawnSync(csc, ["/nologo", `/out:${exePath}`, srcPath], { encoding: "utf8" });
    assert(
      !compile.error && compile.status === 0,
      `csc.exe failed to compile the uvx stub: ${(compile.stderr || compile.stdout || "").trim()}`
    );
  } else {
    const scriptPath = path.join(dir, "uvx");
    fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$UVX_STUB_LOG"\n');
    fs.chmodSync(scriptPath, 0o755);
  }
  return { dir, log };
}

/**
 * Spawn the real wrapper (`args[0]` is the wrapper path, the rest is the
 * manifest's own argv) with `stub.dir` first on PATH, and return its exit
 * status plus the argv the stub recorded (split on lines, trailing empty
 * entry dropped). `logExists` is false when uvx was never actually reached.
 */
function runWrapper(args, cwd, stub) {
  fs.rmSync(stub.log, { force: true });
  const env = { ...process.env, PATH: stub.dir, Path: stub.dir, UVX_STUB_LOG: stub.log };
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  const logExists = fs.existsSync(stub.log);
  let recorded = [];
  if (logExists) {
    recorded = fs.readFileSync(stub.log, "utf8").split(/\r?\n/);
    if (recorded.length > 0 && recorded[recorded.length - 1] === "") recorded.pop();
  }
  return { status: result.status, stderr: result.stderr ?? "", recorded, logExists };
}

function codexManifestArgs() {
  return readManifest(".codex-plugin").mcpServers.serena.args.map((a) =>
    substitute(a, { PLUGIN_ROOT: repoRoot })
  );
}

/**
 * Assert that `recorded` is `codexArgs.slice(1)` with the `--project-from-cwd`
 * token replaced **in place** by `--project <ws>` — not just "a --project
 * pair exists somewhere and the rest matches once you remove it from
 * wherever it sits". A wrapper that merely prepended `--project <cwd>` to
 * the front of argv (leaving `--project-from-cwd` to be stripped separately,
 * or left elsewhere) would satisfy the weaker check but hand uv/uvx a
 * differently-ordered argv than intended. So this walks both arrays by
 * position: every non-project-flag slot must match exactly, and the
 * `--project`/value pair must land at the exact index `--project-from-cwd`
 * held.
 */
function assertRewrittenToProjectCwd(recorded, codexArgs, ws) {
  assert(
    !recorded.includes("--project-from-cwd"),
    `--project-from-cwd still forwarded: ${JSON.stringify(recorded)}`
  );
  const source = codexArgs.slice(1);
  const expectedShape = source.flatMap((a) =>
    a === "--project-from-cwd" ? ["--project", null] : [a]
  );
  assertEqual(
    recorded.length,
    expectedShape.length,
    `recorded argv length (recorded: ${JSON.stringify(recorded)}, expected shape: ${JSON.stringify(expectedShape)})`
  );
  const wsReal = fs.realpathSync(ws);
  expectedShape.forEach((expected, i) => {
    if (expected === null) {
      // The --project value slot: compare via realpath since a mkdtemp path
      // may resolve through a symlink (e.g. macOS /tmp -> /private/tmp).
      assertEqual(
        fs.realpathSync(recorded[i]),
        wsReal,
        `--project value at position ${i} (recorded: ${JSON.stringify(recorded)})`
      );
    } else {
      assertEqual(
        recorded[i],
        expected,
        `arg mismatch at position ${i} (recorded: ${JSON.stringify(recorded)})`
      );
    }
  });
}

const uvxStub = makeUvxStub();

test("boot-wrapper: codex argv under an ancestor .serena project → uvx gets --project <cwd>", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ancestor-"));
  try {
    const ancestorYmlDir = path.join(parent, ".serena");
    fs.mkdirSync(ancestorYmlDir, { recursive: true });
    const ancestorYmlPath = path.join(ancestorYmlDir, "project.yml");
    const ancestorYmlBefore = "languages:\n- python\n";
    fs.writeFileSync(ancestorYmlPath, ancestorYmlBefore);
    const ws = path.join(parent, "ws");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });

    const codexArgs = codexManifestArgs();
    const { status, recorded, logExists } = runWrapper(codexArgs, ws, uvxStub);

    assertEqual(status, 0, "wrapper exit status");
    assert(logExists, "uvx stub log was not written — uvx was not launched from PATH");
    assertRewrittenToProjectCwd(recorded, codexArgs, ws);

    // Additional edge-case coverage (may already pass): the heal ran (if at
    // all) against ws, never against the ancestor marker that caused the bug.
    assertEqual(
      fs.readFileSync(ancestorYmlPath, "utf8"),
      ancestorYmlBefore,
      "ancestor project.yml was modified"
    );
    assert(
      !fs.existsSync(path.join(ws, ".serena")),
      "ws/.serena was created — heal ran against the wrong directory"
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("boot-wrapper: codex argv without any ancestor marker → uvx gets --project <cwd>", () => {
  // "No ancestor marker" is only established inside this mkdtemp subtree, not
  // literally every ancestor up to the filesystem root.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codex-no-ancestor-"));
  try {
    const codexArgs = codexManifestArgs();
    const { status, recorded, logExists } = runWrapper(codexArgs, ws, uvxStub);

    assertEqual(status, 0, "wrapper exit status");
    assert(logExists, "uvx stub log was not written — uvx was not launched from PATH");
    assertRewrittenToProjectCwd(recorded, codexArgs, ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("boot-wrapper: claude argv reaches PATH uvx verbatim", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-project-"));
  try {
    const claudeArgs = readManifest(".claude-plugin").mcpServers.serena.args.map((a) =>
      substitute(a, { CLAUDE_PLUGIN_ROOT: repoRoot, CLAUDE_PROJECT_DIR: projectDir })
    );

    const { status, recorded, logExists } = runWrapper(claudeArgs, repoRoot, uvxStub);

    assertEqual(status, 0, "wrapper exit status");
    assert(logExists, "uvx stub log was not written — uvx was not launched from PATH");
    assertEqual(
      JSON.stringify(recorded),
      JSON.stringify(claudeArgs.slice(1)),
      "claude argv forwarded verbatim"
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge coverage — manifests and release staging
// ---------------------------------------------------------------------------

test("codex manifest: no CLAUDE_-prefixed variable anywhere", () => {
  const raw = fs.readFileSync(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8");
  assert(!/\$\{CLAUDE_/.test(raw), "Codex manifest references a CLAUDE_ variable");
});

test("claude manifest: still uses CLAUDE_PLUGIN_ROOT / CLAUDE_PROJECT_DIR and args[0] resolves", () => {
  const server = readManifest(".claude-plugin").mcpServers.serena;
  assertEqual(server.args[0], "${CLAUDE_PLUGIN_ROOT}/scripts/serena-boot-wrapper.mjs", "args[0]");
  assert(server.args.includes("${CLAUDE_PROJECT_DIR}"), "CLAUDE_PROJECT_DIR missing");
  const first = substitute(server.args[0], { CLAUDE_PLUGIN_ROOT: repoRoot });
  assert(fs.existsSync(first), `args[0] does not exist: ${first}`);
});

test("release.yml stages the Codex manifest and every plugin-root dir either manifest references", () => {
  const release = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const refs = new Set();
  for (const dir of [".claude-plugin", ".codex-plugin"]) {
    for (const a of readManifest(dir).mcpServers.serena.args) {
      const m = /^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/([^/]+)\//.exec(a);
      if (m) refs.add(m[1]);
    }
  }
  assert(refs.size > 0, "no plugin-root-relative references found");
  for (const d of refs) {
    assert(new RegExp(`cp -a ${d}(/\\.)? `).test(release), `release.yml stage step does not copy ${d}/`);
  }
  assert(release.includes("cp .codex-plugin/plugin.json"), "release.yml does not stage the Codex manifest");
});

fs.rmSync(uvxStub.dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
