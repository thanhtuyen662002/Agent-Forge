# Owner desktop workflows

This document describes owner workflows that are implemented and covered by
tests in the desktop app. It is written against the code in this repository,
not against a live provider account or a signed installer. Remaining work for
Issue #225 is listed at the end.

## Agent Center: add, edit, remove and restore agents

Open **Agent Center** in the sidebar. Agents are grouped by role (managers,
coders, reviewers, tool agents). Every group is shown, even when it is empty.

### Add an agent

Click **Add agent**. The form has three steps:

1. **Name and role.** Pick one of *Primary manager*, *Backup manager*, *Coder*,
   *Reviewer* or *Tool*. Each role has a one-line explanation.
2. **How it connects.** Only connections Agent Forge can actually run are
   offered:
   - **Manual Bridge**: you relay each work order to a chat window yourself.
     The agent has no account and no worker slots.
   - **Codex CLI** / **Gemini CLI**: the local command-line tool runs on this
     computer. Agent Forge creates a separate native sign-in profile reference
     (`native-profile://codex/<name>` or `native-profile://gemini/<name>`). You
     may name the profile or leave it empty to generate one. You also choose
     how many tasks it may run in parallel (1 or 2, matching the bounded
     self-host runtime).
   - Enter the model name the tool should use.
3. **Optional instructions** that are stored on the agent's profile.

Saving runs one immediate SQLite transaction
(`WorkspaceManagementService.createAgent`) that creates, as separate rows:

| Identity | Table | Notes |
| --- | --- | --- |
| Role profile | `role_profiles` | Reuses the first enabled profile for the role, otherwise creates one. |
| Agent profile | `agent_profiles` | Name, instructions and connection kind. |
| Provider | `providers` | `prov-manual-bridge`, `prov-codex-cli` or `prov-gemini-cli`, created only if missing. |
| Account | `provider_accounts` | CLI connections only. `NATIVE_PROFILE` auth, no credential, health `UNKNOWN`. |
| Resource | `provider_resources` | Model name, role capabilities, quota `UNKNOWN`. |
| Worker slots | `worker_slots` | CLI connections only, `IDLE`. |
| Agent | `agents` | Linked to the resource and agent profile (migration 027). |

If any step fails, for example because the sign-in profile is already bound
to another account, nothing is written. New accounts and resources start as
`UNKNOWN`; the form says so, and nothing marks them healthy until a supported
observation exists. Creating a CLI agent does **not** sign in to Codex or
Gemini and does not prove the tool is installed.

### Edit an agent

**Edit** changes the display name, the instructions and the model name. The
role and connection are fixed after creation; create a new agent for a
different connection. The model cannot change while the agent has active work
(see blockers below), so approved work never runs against a model the owner
did not see.

### Remove and restore an agent

**Remove** asks for confirmation, then sets `agents.removed_at` and parks the
agent `OFFLINE`. It also disables the agent's resource (so routing skips it),
its worker slots and its agent profile. No row is deleted: decisions, events,
reviewer sessions, assignments and evidence keep their references. Seeded
agents can be removed too, and startup seeding does not bring them back.

Turn on **Show removed agents** to see removed agents and **Restore** them.
Restore clears the marker, re-enables the resource and profile, and returns
disabled slots to `IDLE`.

Remove is refused, and the card lists the reason, while the agent has any of
these:

- a current task, or `BUSY` status;
- an open (unrevoked, unexpired) reviewer MCP session;
- an `ASSIGNED`/`RUNNING` assignment on its resource;
- an `AUTHORIZED` execution authorization, or a dispatched one whose adapter
  started and has not finished;
- a worker slot that is `LEASED`, `RUNNING`, or holds an assignment or execution;
- an unreleased account lease on one of its slots (expired leases still block
  until recovery releases them).

### IPC surface

All channels go through the trusted-sender check and sanitize their output.

| Channel | Payload | Reply |
| --- | --- | --- |
| `agents:roster` | `{ includeRemoved }` | `AgentRosterEntry[]` |
| `agents:create` | `CreateAgentIpcSchema` | `{ success: true, agent }` or `{ success: false, errorCode, error, blockers? }` |
| `agents:update` | `UpdateAgentIpcSchema` | same |
| `agents:remove` | `{ agentId }` | same |
| `agents:restore` | `{ agentId }` | same |

The renderer (`src/ui/agentRoster.ts`) only treats a reply as saved when it is
an explicit success envelope that carries the persisted agent. Malformed
replies show an error and are not counted as success.

## Not yet covered by this slice of Issue #225

- Trash and restore for projects and tasks, and search.
- Natural-text project goal/constraint input instead of JSON contracts.
- A desktop Start/Pause control wired to the bounded execution runtime.
- Automatic quota refresh and Codex device-code sign-in.
- Dashboard setup/blocker guidance.

These remain open acceptance criteria on Issue #225.
