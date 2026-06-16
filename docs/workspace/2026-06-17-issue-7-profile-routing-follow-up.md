# Issue #7 Profile Routing Follow-up

Date: 2026-06-17 JST
Repository: ZeroPointSix/ssh-mcp-chatgpt
Issue: https://github.com/ZeroPointSix/ssh-mcp-chatgpt/issues/7
PR: https://github.com/ZeroPointSix/ssh-mcp-chatgpt/pull/8
Sandbox workspace: ws-8714f40b-4632-4b5b-85e3-bca70770b77d

## Context Checked

- Read Issue #7, issue comments, PR #8 metadata, PR conversation, review threads, review submissions, and commit check/workflow state.
- Confirmed PR #8 has no inline review threads and no review submissions, but it has an actionable PR comment from 2026-06-16 identifying a blocking profile configuration priority mismatch.
- Confirmed the PR head had no GitHub commit statuses or workflow runs visible through the connector at inspection time.
- Searched the repository for existing Workspace trace documents; none were present before this file.
- Searched Google Drive for `ssh-mcp-chatgpt` and Issue #7-related Workspace records; found prior BUG-v3/sandbox feedback docs, but no dedicated Issue #7 Workspace trace.

## Changes Made

- Updated `loadRawProfilesConfig()` so `SSH_MCP_PROFILES_FILE` takes precedence over `SSH_MCP_PROFILES_JSON`, matching README and deployment guidance.
- Added a regression test proving that when both environment variables are configured, the file-backed profile set wins and the inline JSON profile is not exposed.
- Updated command input schema descriptions to refer to the selected SSH profile instead of the old single-target wording.

## Validation Plan

- Run `npm run build` in the remote sandbox.
- Run `npm test` in the remote sandbox.
- Post validation results back to PR #8 and Issue #7 before ending the run.

## Validation Results

- `npm ci --ignore-scripts --foreground-scripts`: passed after an initial silent `npm ci` attempt was cancelled and retried with visible foreground output. `npm audit` reported existing dependency advisories: 26 total, including 2 critical.
- `npm run build`: passed.
- First `npm test`: failed because no SSH service was listening on `127.0.0.1:2222`; the new profile regression test passed in that run.
- Started the repository-equivalent SSH test service in the sandbox with `USER_NAME=test`, `USER_PASSWORD=secret`, `SUDO_ACCESS=true`, and shared the workspace runtime network so hard-coded `127.0.0.1:2222` tests could reach it.
- Final `npm test`: passed, 8 test files and 66 tests.

## Remaining Notes

- GitHub commit statuses and workflow runs were not visible for the inspected PR head through the connector, so this run provides the visible sandbox verification record.
- Sandbox usability note: shell redirection to `/dev/null` was blocked by workspace path policy, and Docker port publishing was not reachable from the workspace runtime via `127.0.0.1`; using a shared network namespace resolved the test-service access issue.

## Scheduled Patrol - 2026-06-17 04:15 JST

- Re-read Issue #7, all issue comments, PR #8 metadata, PR conversation comments, review thread state, commit status state, workflow run state, repository Workspace notes, and the profile-routing code/tests/docs on branch `codex/issue-7-profile-routing` at `63074106963bd7d617b06b59c5c5a51d761adc36`.
- Confirmed the previous blocking review item was already addressed: `SSH_MCP_PROFILES_FILE` takes priority over `SSH_MCP_PROFILES_JSON`, a regression test covers that precedence, and the command schema wording now refers to SSH profiles instead of the old single-target phrasing.
- Found no unresolved inline review threads, no new Issue #7 blockers, and no need for additional business-code changes in this patrol.
- GitHub commit statuses and workflow runs were still not visible for PR #8 through the connector or CLI inspection, so remote sandbox validation remains the current visible verification evidence.
- Reused sandbox workspace `ws-8714f40b-4632-4b5b-85e3-bca70770b77d`; started a temporary SSH test container in the workspace runtime network for the live SSH tests.
- `npm run build`: passed.
- `npm test`: passed, 8 test files and 66 tests.
- Remaining risk: PR #8 is still draft/open and CI visibility remains absent; no automatic merge was performed.
