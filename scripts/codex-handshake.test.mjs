#!/usr/bin/env node
/**
 * codex-handshake.test.mjs — driving test for ticket #47's R2.
 *
 * Spawns the release-staged Codex MCP declaration exactly the way Codex
 * would (its own `command`/`cwd`/`args`, no substitution), sends a real
 * newline-delimited JSON-RPC `initialize` + `tools/list`, then binds the
 * project the way the new SKILL.md paragraph instructs the model to (an
 * explicit `activate_project` call is the client-initiated activation this
 * test proves — Codex supplies no workspace hint at startup, so nothing
 * here shows the host doing that binding automatically) before calling
 * `get_symbols_overview` on a fixture file.
 *
 * Needs `uvx` and `bash` on PATH; the first run downloads/builds Serena's
 * uv-managed environment, hence the generous overall deadline below.
 *
 * Run: node scripts/codex-handshake.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { stageTree, resolveCodexServer } from "./codex-staged-server.mjs";

const OVERALL_TIMEOUT_MS = 600000; // cold `uvx` download/build of Serena's env

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

// ---------------------------------------------------------------------------
// Minimal newline-delimited JSON-RPC line reader over a readable stream.
// ---------------------------------------------------------------------------

function makeLineReader(stream) {
  let buffer = "";
  const pending = [];
  const waiters = [];
  let failure = null;

  function deliver(line) {
    if (waiters.length > 0) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve(line);
    } else {
      pending.push(line);
    }
  }

  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.trim() !== "") deliver(line);
    }
  });

  return {
    /** Resolve with the next non-empty line, or reject once `deadline` (epoch ms) passes. */
    next(deadline) {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        if (pending.length > 0) {
          resolve(pending.shift());
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error("deadline exceeded waiting for a line on stdout"));
          return;
        }
        const w = { resolve, reject };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error(`timed out after ${remaining}ms waiting for a line on stdout`));
        }, remaining);
        waiters.push(w);
      });
    },
    /**
     * Immediately reject every outstanding and future `next()` call. Used
     * when the child process exits or fails to spawn, so a dead process
     * fails the test fast instead of idling out the full overall deadline.
     */
    fail(err) {
      if (!failure) failure = err;
      while (waiters.length > 0) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.reject(err);
      }
    },
  };
}

async function recvResponse(reader, id, deadline) {
  for (;;) {
    const line = await reader.next(deadline);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not JSON (a stray log line) — keep waiting for the real response
    }
    if (msg.id === id) return msg;
  }
}

/**
 * Spawn the resolved Codex declaration and run the message sequence R2
 * requires: initialize, notifications/initialized, tools/list,
 * activate_project(workspaceDir), get_symbols_overview("a.py"). Returns the
 * four responses plus a snapshot of stderr/exit info for diagnosis.
 *
 * `server.cwd` (the staged plugin root, not `workspaceDir`) is the process's
 * cwd — Codex never supplies the workspace at spawn time (that premise is
 * settled in the plan: projectless start + client-initiated
 * `activate_project`), so this test must not fake a hint Codex doesn't give.
 */
async function runHandshake(server, workspaceDir, deadline) {
  const scriptPath = path.resolve(server.cwd, server.args[0]);
  const args = [scriptPath, ...server.args.slice(1)];
  const child = spawn(server.command, args, { cwd: server.cwd, stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  const reader = makeLineReader(child.stdout);

  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    if (code !== 0) {
      // A dead process will never write the next line — fail fast rather
      // than idling out the full overall deadline waiting for one.
      reader.fail(new Error(`process exited early (code=${code}, signal=${signal}) before a response arrived`));
    }
  });
  child.on("error", (err) => {
    exitInfo = { spawnError: err.message };
    reader.fail(new Error(`spawn error: ${err.message}`));
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex-handshake-test", version: "0.0.0" },
      },
    });
    const initializeResult = await recvResponse(reader, 1, deadline);

    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsListResult = await recvResponse(reader, 2, deadline);

    // Client-initiated activation: this call is the test simulating the
    // agent's first Serena call under the new SKILL.md Codex paragraph, not
    // something Codex or Serena supplies on its own.
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "activate_project", arguments: { project: workspaceDir } },
    });
    const activateResult = await recvResponse(reader, 3, deadline);

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_symbols_overview", arguments: { relative_path: "a.py" } },
    });
    const overviewResult = await recvResponse(reader, 4, deadline);

    return { initializeResult, toolsListResult, activateResult, overviewResult, stderr, exitInfo };
  } catch (err) {
    err.message += `\n      stderr tail: ${JSON.stringify(stderr.slice(-4000))}\n      exit: ${JSON.stringify(exitInfo)}`;
    throw err;
  } finally {
    killTree(child);
  }
}

/**
 * Kill `child` and, on win32, its whole descendant tree by PID — not by
 * image name. `child.kill()` alone only signals the immediate child (the
 * node boot wrapper); the wrapper's own `spawnSync("uvx", ...)` call spawns
 * uv's grandchildren (python, the actual serena process) which are not
 * necessarily reaped when the wrapper dies, and one of them may still hold
 * `server.cwd` (the staged temp dir) as its own current directory — which
 * Windows locks, causing the test's `fs.rmSync(dest, ...)` cleanup to fail
 * with EPERM even though the handshake assertions above already passed.
 * `taskkill /PID <pid> /T /F` is scoped to exactly this one process's
 * descendants; it must never be replaced with an image-name-based kill
 * (`/IM uvx.exe` etc.), which would reach unrelated processes on a shared
 * machine running other sessions.
 */
function killTree(child) {
  if (child.pid && process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fall through to the plain kill below
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}

/**
 * Delete `dir` recursively, retrying briefly if Windows still has a
 * just-killed process's file handle open (EPERM/EBUSY on a fresh kill is
 * transient — the handle releases within milliseconds of process exit).
 * Logs and swallows a final persistent failure rather than letting cleanup
 * noise overwrite the test's real pass/fail result.
 */
function rmDirRetrying(dir, label) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        console.log(`      (cleanup) could not remove ${label} (${dir}): ${err.message}`);
        return;
      }
    }
  }
}

function makeFixtureWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-ws-"));
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.writeFileSync(path.join(ws, "a.py"), "def hello():\n    pass\n");
  return ws;
}

// ---------------------------------------------------------------------------
// #47 R2 — started with only Codex-supplied inputs, the real boot wrapper
// completes initialize + tools/list, and the project only becomes the
// fixture workspace because the test itself activates it (client-initiated,
// not host- or server-supplied).
// ---------------------------------------------------------------------------

await test(
  "staged codex declaration completes initialize + tools/list, and client-initiated activate_project binds the fixture workspace (not the plugin install dir)",
  async () => {
    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-staged-"));
    const ws = makeFixtureWorkspace();
    try {
      const staged = stageTree(dest);
      assert(!staged.error, `stageTree failed to run: ${staged.error?.message}`);
      assert(
        staged.status === 0,
        `stage-tree.sh exit status ${staged.status} (stderr: ${staged.stderr ?? ""})`
      );

      const server = resolveCodexServer(dest);
      const { initializeResult, toolsListResult, activateResult, overviewResult } =
        await runHandshake(server, ws, deadline);

      assert(!initializeResult.error, `initialize returned an error: ${JSON.stringify(initializeResult.error)}`);
      assert(!!initializeResult.result, "initialize returned no result");

      assert(!toolsListResult.error, `tools/list returned an error: ${JSON.stringify(toolsListResult.error)}`);
      const toolNames = (toolsListResult.result?.tools ?? []).map((t) => t.name);
      assert(
        toolNames.includes("find_symbol") || toolNames.includes("get_symbols_overview"),
        `tools/list did not name a Serena tool: ${JSON.stringify(toolNames)}`
      );

      assert(!activateResult.error, `activate_project returned an error: ${JSON.stringify(activateResult.error)}`);

      assert(
        !overviewResult.error,
        `get_symbols_overview returned an error: ${JSON.stringify(overviewResult.error)}`
      );
      const overviewText = JSON.stringify(overviewResult.result ?? "");
      assert(
        overviewText.includes("hello"),
        `get_symbols_overview did not report the fixture's "hello" function: ${overviewText}`
      );

      // Additional edge-case coverage: the plugin install dir is never
      // treated as a Serena project — no .serena/ appears under the staged
      // root even after a real session ran against it.
      assert(
        !fs.existsSync(path.join(server.cwd, ".serena")),
        ".serena/ was created under the staged plugin root — the plugin dir was treated as the project"
      );
    } finally {
      rmDirRetrying(dest, "staged tree");
      rmDirRetrying(ws, "fixture workspace");
    }
  }
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
