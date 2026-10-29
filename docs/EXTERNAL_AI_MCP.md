# External AI control over MCP (#289)

The owner can hand work to an external AI they already talk to, such as
Claude Code or Codex. That AI then drives Agent Forge through a local
[Model Context Protocol](https://modelcontextprotocol.io) server. It can
create the project, write and approve the plan, set the test command, turn
on automation, start the work and report progress. The owner does not have
to operate the Agent Forge UI.

## Turning it on

Go to **Settings → Kết nối AI bên ngoài (MCP)** and tick **Cho phép AI bên
ngoài kết nối và điều khiển Agent Forge**. The panel then shows:

- the address, by default `http://127.0.0.1:47615/mcp`;
- the access token, hidden until **Hiện** is pressed. **Tạo khóa mới**
  replaces it, and the old token is refused from its next request.
- a ready-made **Claude Code** command:

  ```
  claude mcp add --transport http --scope user agent-forge http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"
  ```

- the **Codex** setup. First store the token in an environment variable (run
  once, then reopen the terminal):

  ```
  setx AGENT_FORGE_MCP_TOKEN "<token>"
  ```

  Then add this to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.agent_forge]
  url = "http://127.0.0.1:47615/mcp"
  bearer_token_env_var = "AGENT_FORGE_MCP_TOKEN"
  ```

After that, the owner simply asks the AI, for example: *"Use Agent Forge to
create a project for D:/Projects/my-app, write a plan to add …, then start it
and report progress to me."*

Agent Forge must be running for the AI to connect. The setting is remembered
across restarts.

## Tools

| Tool | What it does |
| --- | --- |
| `get_overview` | Lists projects with status and automation phase, plus the configured agents |
| `get_project` | Shows one project in detail: plan, tasks and progress, automation phase, Manager mode and proposals, test command, reviewed work, auto-integration |
| `create_project` | Creates a project for a local Git working tree. The path gets the same checks as the folder picker: root identity, path policy and Git status |
| `set_project_plan` | Saves the plan (contract): goal, acceptance criteria, tests, non-goals, rules for the agents, … |
| `approve_plan` | Approves the saved plan |
| `set_test_command` | Sets and approves the verification command, for example `node run-tests.js` |
| `configure_automation` | Sets Manager mode `AUTO`/`APPROVE`, automatic integration into the default branch, and `parallelTasks` (1–10 tasks at once, #306) |
| `start_project` / `pause_project` / `resume_project` | Controls the project |
| `add_task` | Adds a task by hand |
| `list_events` | Returns the latest events, newest last |
| `integrate_reviewed_work` | Integrates one task's reviewed work now |
| `decide_manager_proposal` | Approves or rejects a Manager proposal in `APPROVE` mode |
| `retry_task` | Retries a `NEEDS_HUMAN` task with 3 more revisions (#318) |

Every tool calls the same main-process handler as the desktop UI. Validation,
the trash fence and output sanitization are therefore identical. A handler
refusal is returned as a tool error (`isError: true`) and is never reported as
success.

## Security

- **Off by default.** Enabling it is the owner's explicit delegation, and the
  Settings warning says so.
- **Loopback only.** The server binds `127.0.0.1`. A request with an `Origin`
  header (a browser page) or a `Host` other than loopback is refused, which
  blocks DNS rebinding.
- **Token required.** Every request needs `Authorization: Bearer <token>`.
  The token is 32 random bytes, compared in constant time, and stored only in
  the app's user-data `mcp-settings.json` (owner-only permissions). It is
  never in Git, logs or evidence.
- **Allow-list.** Only the channels behind the tools above can be invoked.
  Credentials, sign-in, updates and releases, and the MCP settings themselves
  are never reachable over MCP.
- **Test command approval.** An MCP caller may approve the test command
  without the native dialog. The connected CLI agent can already run commands
  on this machine, so this grants it nothing new. Renderer calls still require
  the native dialog, and the command parser's refusals (`node -e`, `npx`,
  scripts outside the project, …) apply unchanged.
- **Nothing is pushed.** Agent Forge never pushes to a remote. Reviewed code
  lands only on the local default branch.

## Protocol

The server implements Streamable HTTP with JSON responses (`POST /mcp`,
protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`):

- requests: `initialize`, `ping`, `tools/list` and `tools/call`;
- notifications are acknowledged with `202`;
- `GET` returns `405` (there is no server-initiated stream), and batches are
  refused;
- request bodies are limited to 1 MiB.
