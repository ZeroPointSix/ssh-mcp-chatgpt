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
