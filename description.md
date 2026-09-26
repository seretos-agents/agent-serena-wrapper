# agent-serena-wrapper

Gives Claude Code (and Codex) token-efficient, symbol-aware code navigation and
editing by bundling the headless Serena MCP server together with a skill that
teaches the agent when to reach for it. Instead of reading or grepping whole
files, the agent works with code through precise semantic operations.

## Key features

- **Zero-setup MCP server** — Serena is declared inline in the plugin manifest
  and launched headlessly via `uvx` on install. No manual server, no
  `pip install`, no config step.
- **Symbol-aware navigation** — find where a function, class, or symbol is
  defined and read a single method or class body without loading whole files
  into context.
- **Reference & caller lookup** — find every caller or usage of a symbol, and
  locate all implementations of an interface or trace inheritance.
- **Project-wide rename** — rename a symbol consistently across the whole
  codebase via language-server-backed edits.
- **Precise semantic edits** — insert, replace, or delete code at the symbol
  level instead of line-by-line patching.
- **Project memory store** — list, read, write, edit, rename, and delete
  durable notes under `.serena/memories/` so findings survive across
  sessions instead of being re-derived every time.
- **Monorepo-correct rooting** — the Claude Code plugin roots Serena at
  `CLAUDE_PROJECT_DIR`, so it resolves the exact sub-repo you opened rather than
  the process working directory; the Codex plugin auto-detects from the CWD.
- **Automatic usage reminder** — a `PreToolUse` hook nudges the agent toward
  Serena's semantic tools when it reaches for `Read`/`Glob`/`Grep`, and stays a
  silent no-op in repositories that don't use Serena.
- **Works in Claude Code and Codex** — ships both a `.claude-plugin` and a
  `.codex-plugin` manifest from one repository.

## Requirements

- `uv` must be installed on the host machine; `uvx` (bundled with `uv`) launches
  Serena on demand. See https://docs.astral.sh/uv/getting-started/installation/

## A good fit if you want to

- Explore and understand an unfamiliar codebase quickly.
- Cut token usage on code-understanding tasks by avoiding whole-file reads.
- Get reliable, structure-aware edits and renames.
- Carry findings across sessions instead of re-deriving them each time.
