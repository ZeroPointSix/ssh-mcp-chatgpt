# PR #8 Review and VPS Simulation Trace

Date: 2026-06-17 JST
Repository: ZeroPointSix/ssh-mcp-chatgpt
Issue: https://github.com/ZeroPointSix/ssh-mcp-chatgpt/issues/7
PR: https://github.com/ZeroPointSix/ssh-mcp-chatgpt/pull/8
Reviewed code head: `0f1381390900fc442c5872d3c8a55313a6cc55fa`
Sandbox workspace: `ws-df27d226-c450-402e-835c-02f6e0f64367`
VPS validation: temporary Docker deployment on localhost port `13008`

## Context Checked

- Re-read PR #8 metadata, patch, PR conversation comments, review submissions, review thread state, commit status state, and workflow run state.
- Re-read Issue #7 and issue comments to confirm PR #8 is the active implementation for profile-based multi-VPS target routing.
- Reviewed the profile routing implementation around profile config loading, non-sensitive `list-profiles`, target resolution, per-profile sudo gating, job target metadata, health payload, and MCP `tools/list` / `tools/call` handling.
- Reviewed `test/chatgpt-http.profiles.test.ts`, including file-over-inline priority, empty profile config startup failure, default profile behavior, explicit target selection, unknown target errors, per-profile sudo gating, legacy fallback, and audit redaction coverage.
- Confirmed there were no unresolved inline review threads and no GitHub commit statuses or workflow runs visible through the connector for the inspected head.

## Sandbox Validation

Remote sandbox workspace: `ws-df27d226-c450-402e-835c-02f6e0f64367` using the quality runtime.

- `npm ci --ignore-scripts --foreground-scripts`: passed. npm audit still reports 26 existing advisories, including 2 critical.
- `npm test -- test/chatgpt-http.profiles.test.ts`: passed, 1 file and 9 tests.
- `npm run build`: passed.
- Started a temporary live SSH test container using the repository's `test` / `secret` / sudo-enabled configuration and shared the workspace runtime network so tests could reach `127.0.0.1:2222`.
- `npm test`: passed, 8 files and 67 tests.
- Removed the temporary `ssh-mcp-pr8-vps-test` container after validation.
- Sandbox working tree remained clean after cleanup.

## VPS Simulation

VPS environment did not have Node/npm installed, so the simulation used the repository Dockerfile for a closer deployment path.

- Cloned PR branch `codex/issue-7-profile-routing` on the VPS and confirmed head `0f1381390900fc442c5872d3c8a55313a6cc55fa`.
- Built Docker image from the PR Dockerfile; build passed.
- Started two temporary OpenSSH containers on an isolated Docker network as profile targets:
  - `alpha`: default profile, sudo enabled.
  - `beta`: explicit target, sudo disabled.
- Started the HTTP service container bound to `127.0.0.1:13008` with `SSH_MCP_PROFILES_JSON`, `SSH_MCP_DEFAULT_PROFILE=alpha`, and a static bearer token for local API validation.
- Verified `GET /health` reports profile routing enabled, profile count `2`, and default profile `alpha`.
- Verified `list-profiles` returns only non-sensitive metadata and does not expose hostnames or credential material.
- Verified default `exec` without `target_id` routes to `alpha` and reports `target_id=alpha` / `target_label=Alpha target`.
- Verified explicit `exec` with `target_id=beta` routes to `beta` and reports `target_id=beta` / `target_label=Beta target`.
- Verified unknown `target_id=missing` returns structured error code `TARGET_NOT_FOUND`.
- Verified `sudo-exec` against `beta` returns structured error code `SUDO_DISABLED`.
- First `/mcp` attempt returned `406` because the request omitted the required `Accept: application/json, text/event-stream` header; this was corrected and the full simulation then passed.
- Cleanup confirmed no leftover `pr8-*` containers, no `pr8-route-net-*` Docker networks, and no remaining listener on port `13008`. Temporary PR image tags were removed.

## Review Result

No new code blocker was found in this review pass.

Remaining non-blocking notes:

- PR #8 is still draft/open.
- GitHub CI/check results were not visible for the inspected head, so the sandbox and VPS runs above are the current verification evidence.
- Existing npm audit advisories remain outside the scope of this profile-routing PR.
- This document is a docs-only trace added after validation; no business-code changes were made in this pass.
