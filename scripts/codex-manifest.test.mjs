#!/usr/bin/env node
/**
 * codex-manifest.test.mjs — regression guard, tickets #38/#47.
 *
 * Checks the boot wrapper reports a failed spawn instead of exiting
 * silently (#38), that the Claude manifest's launch argv still resolves
 * with only Claude's own variables (R3, unchanged by #47), and that the
 * release-staged Codex declaration resolves and launches cleanly with only
 * the inputs Codex itself supplies — no `${PLUGIN_ROOT}` substitution, no
 * `.mcp.json` double-registration with Claude Code, and no `--project` flag
 * reaching uvx (#47 R1; see codex-staged-server.mjs and
 * .github/scripts/stage-tree.sh). The real handshake against a spawned
 * Serena process is #47 R2, in codex-handshake.test.mjs.
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
import { stageTree, resolveCodexServer } from "./codex-staged-server.mjs";

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
// Shared uvx-stub fixture: run the real wrapper as a child process (via
// `process.execPath`, not an injected/mocked spawnSync) with a `uvx` stub
// placed first on PATH that records the argv it actually received.
// `captureRun` above stays unchanged and serves only the spawn-error/success
// tests.
// ---------------------------------------------------------------------------

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

const uvxStub = makeUvxStub();

// ---------------------------------------------------------------------------
// #47 R1 — the release-staged Codex declaration resolves with only
// Codex-supplied inputs (no ${PLUGIN_ROOT} substitution, no .mcp.json
// double-registration, no --project flag reaching uvx).
// ---------------------------------------------------------------------------

test("staged codex declaration resolves without placeholder expansion", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staged-"));
  try {
    const staged = stageTree(dest);
    assert(!staged.error, `stageTree failed to run: ${staged.error?.message}`);
    assertEqual(
      staged.status,
      0,
      `stage-tree.sh exit status (stderr: ${staged.stderr ?? ""})`
    );

    const server = resolveCodexServer(dest);
    assertEqual(server.command, "node", "command");
    for (const a of server.args) {
      assert(!a.includes("${"), `unsubstituted placeholder left in arg: ${a}`);
    }
    const scriptPath = path.resolve(server.cwd, server.args[0]);
    assert(fs.existsSync(scriptPath), `args[0] does not resolve to a file on disk: ${scriptPath}`);

    // Launch the resolved command itself, with PATH holding only node's own
    // directory, so a placeholder or unresolvable path fails the launch
    // rather than something downstream (uvx) papering over it.
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staged-node-"));
    const nodeName = path.basename(process.execPath);
    fs.copyFileSync(process.execPath, path.join(nodeDir, nodeName));
    const env = { ...process.env, PATH: nodeDir, Path: nodeDir };
    const result = spawnSync(server.command, server.args, {
      cwd: server.cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    assert(!result.error, `could not launch declared command ${JSON.stringify(server.command)}: ${result.error?.message}`);
    const stderr = result.stderr ?? "";
    assert(
      !/Cannot find module|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/.test(stderr),
      `node failed to load the staged launch script: ${stderr.split("\n")[0]}`
    );
    // MCP stdio: stdout carries the protocol; the wrapper must not pollute it.
    assertEqual(result.stdout ?? "", "", "stdout of the spawned wrapper");
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("staged tree has no .mcp.json/mcp.json for Claude Code to double-register serena from", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staged-nomcp-"));
  try {
    const staged = stageTree(dest);
    assert(!staged.error, `stageTree failed to run: ${staged.error?.message}`);
    assertEqual(staged.status, 0, `stage-tree.sh exit status (stderr: ${staged.stderr ?? ""})`);
    assert(!fs.existsSync(path.join(dest, ".mcp.json")), "staged tree contains .mcp.json");
    assert(!fs.existsSync(path.join(dest, "mcp.json")), "staged tree contains mcp.json");
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("staged codex declaration argv reaches uvx stub verbatim, with no --project flag", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staged-argv-"));
  try {
    const staged = stageTree(dest);
    assert(!staged.error, `stageTree failed to run: ${staged.error?.message}`);
    assertEqual(staged.status, 0, `stage-tree.sh exit status (stderr: ${staged.stderr ?? ""})`);

    const server = resolveCodexServer(dest);
    const scriptPath = path.resolve(server.cwd, server.args[0]);
    const { status, recorded, logExists } = runWrapper(
      [scriptPath, ...server.args.slice(1)],
      server.cwd,
      uvxStub
    );

    assertEqual(status, 0, "wrapper exit status");
    assert(logExists, "uvx stub log was not written — uvx was not launched from PATH");
    assert(!recorded.includes("--project-from-cwd"), `--project-from-cwd forwarded: ${JSON.stringify(recorded)}`);
    assert(!recorded.includes("--project"), `unexpected --project flag in staged codex argv: ${JSON.stringify(recorded)}`);
    assertEqual(
      JSON.stringify(recorded),
      JSON.stringify(server.args.slice(1)),
      "staged codex argv forwarded verbatim"
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
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

fs.rmSync(uvxStub.dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
