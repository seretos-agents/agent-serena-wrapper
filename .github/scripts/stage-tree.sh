#!/usr/bin/env bash
# stage-tree.sh <dest> — build the install-ready plugin tree at <dest>.
#
# This is the exact copy list release.yml's "Stage install tree and build
# release zip" step uses (minus the zip build itself, which stays in
# release.yml). Ticket #47 extracts it so both release.yml and the local
# tests build the *same* tree — "staged the way release.yml stages it" is
# then literal instead of a regex over the workflow file, which cannot
# reproduce the tree it describes.
#
# Assumes the repo root is the current working directory (release.yml's
# actions/checkout already lands there; the test helper that calls this
# script passes `cwd: repoRoot`).
set -euo pipefail

DEST="${1:?usage: stage-tree.sh <dest>}"

rm -rf "$DEST"
mkdir -p "$DEST/.claude-plugin" "$DEST/.codex-plugin" "$DEST/skills"

cp .claude-plugin/plugin.json "$DEST/.claude-plugin/"
cp .codex-plugin/plugin.json  "$DEST/.codex-plugin/"
# codex-mcp.json is the pointed-to Codex MCP declaration (ticket #47). It does
# not exist yet on every branch of history this script must stage, so it is
# staged like assets/hooks/scripts below: copied when present, skipped when not.
[ -f codex-mcp.json ] && cp codex-mcp.json "$DEST/" || true
cp -a skills/. "$DEST/skills/"
cp README.md "$DEST/"
cp LICENSE "$DEST/" 2>/dev/null || true
# description.md goes onto the orphan release branch so the dispatch
# payload's description_url (raw.githubusercontent.com/${repo}/${TAG}/
# description.md) resolves.
cp description.md "$DEST/"
# assets/ goes onto the orphan release branch so the dispatch payload's icon
# URL (raw.githubusercontent.com/${repo}/${TAG}/assets/icon.png) resolves.
[ -d assets ]  && cp -a assets  "$DEST/" || true
# hooks/ and scripts/ must ship so the PreToolUse hook command resolves.
[ -d hooks ]   && cp -a hooks   "$DEST/" || true
[ -d scripts ] && cp -a scripts "$DEST/" || true
