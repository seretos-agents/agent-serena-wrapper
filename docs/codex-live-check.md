# Codex live-check — Serena MCP connects (ticket #47)

Manual, human-run verification that a real Codex CLI session connects the
bundled Serena MCP server via the new `codex-mcp.json` declaration. This is
deliberately not CI evidence (plan R5, declared `none`): it needs Codex's own
TUI, its own marketplace install path, and a real `~/.codex` plugin cache,
none of which a GitHub Actions runner reproduces.
`scripts/codex-handshake.test.mjs` already proves the release-staged
declaration completes `initialize` + `tools/list` + `activate_project` +
`get_symbols_overview` against the real wrapper and Serena; this document is
the step a human still owes afterward, on a real Codex install.

## Prerequisites

- Codex CLI installed, with `uvx` and `node` on `PATH`.
- A small git repo you can open with Codex (any repo with at least one
  source file works for step 4).

## Steps

1. **Do a genuinely clean install — not a reinstall.** A reinstall over an
   existing plugin directory can silently keep a stale cached copy of the
   plugin tree, including the pre-fix inline `mcpServers` declaration this
   ticket removes — in which case this whole check would validate nothing.
   Remove the existing install before installing fresh:
   ```
   codex plugin remove agent-serena-wrapper
   ```
   Confirm it is actually gone (not just marked disabled):
   ```
   codex plugin list
   ```
   `agent-serena-wrapper` must not appear. If it still does, or if a cached
   copy remains under Codex's plugin cache (e.g.
   `~/.codex/.tmp/plugins/plugins/agent-serena-wrapper`), delete that
   directory by hand before continuing. Then install fresh from the
   marketplace and enable it:
   ```
   codex plugin install agent-serena-wrapper@modular-software-factory
   codex plugin enable agent-serena-wrapper
   ```
   Restart Codex.

2. Ask Codex for its resolved MCP declaration:
   ```
   codex mcp get serena
   ```
   Expect: `cwd: .` and `args` starting with
   `./scripts/serena-boot-wrapper.mjs …`, with **no `${` anywhere** in the
   output — that literal substring is the pre-fix bug (`${PLUGIN_ROOT}` left
   unexpanded).

3. Open a real repo and check the connection status. Run, literally:
   ```
   cd <repo>
   codex
   ```
   Once the Codex TUI is up, type this literal slash command:
   ```
   /mcp
   ```
   Expect: `serena` listed as connected, with its tools enumerated (at least
   `find_symbol` and `get_symbols_overview`). If `serena` is missing, or
   listed but disconnected, or has an empty tool list, the fix did not take —
   stop here and diagnose before continuing.

4. Still inside that same Codex session, send this exact literal prompt
   (replace `<file>` with a real source file path in the repo you opened,
   e.g. `README.md` or a source file you know the contents of):
   ```
   Activate this directory with serena, then call get_symbols_overview on <file>.
   ```
   Expect: Codex calls `activate_project` with the repo's own root (not the
   plugin's install directory), then `get_symbols_overview`, and the reply
   lists `<file>`'s actual top-level symbols — not an error, and not the
   symbols of some file under the plugin's own install directory.

## What a failure here means

- Step 2 shows `${PLUGIN_ROOT}` unexpanded, or `cwd` is anything other than
  `.` → the manifest pointer or `codex-mcp.json` itself regressed.
- Step 3's `/mcp` shows `serena` missing or disconnected → the handshake
  itself is broken; re-run `scripts/codex-handshake.test.mjs` locally first,
  since it exercises the identical release-staged declaration.
- Step 4 returns symbols from the wrong directory, or errors on
  `activate_project` → the SKILL.md Codex-activation paragraph either was not
  followed by the model, or the workspace root passed was wrong — not a
  server-side bug this ticket's tests can catch.
