# Agent Integration: Entry Skill, Executors, and CAO

sLoom's product shape is:

```text
sLoom CLI + Agent Entry Skill + optional MCP/Hook integrations later
```

The CLI owns deterministic state: catalog, routing, plan locking, executor dispatch packages, artifacts, events, and run state. An agent such as Codex CLI, Claude Code, or CAO can recognize when to call sLoom through an Entry Skill (`skills/sloom-orchestrator/SKILL.md`).

## Entry Skill is not a hook

The Entry Skill is prompt-level integration, not an automatic runtime hook. It teaches the surrounding agent:

- when a natural-language development task should become a sLoom workflow;
- which CLI commands to call;
- how to handle `handoff-ready` nodes;
- how to submit artifacts back into the run.

This is intentionally simple and portable. Later integrations can add MCP resources or agent-specific hooks, but the open-source baseline should work anywhere a CLI agent can read a `SKILL.md` and run shell commands.

## Executor modes

```bash
sloom executors
sloom run <plan.json> --executor local
sloom run <plan.json> --executor auto
sloom run <plan.json> --executor handoff
sloom run <plan.json> --executor codex
sloom run <plan.json> --executor claude-code
sloom run <plan.json> --executor cao
```

- `local`: deterministic artifact materialization; never mutates source files.
- `auto`: uses safe shell for policy-approved shell nodes and generic handoff for agent nodes.
- `shell`: only safe allowlisted shell commands under `shell.readonly` or `shell.test`.
- `handoff`: creates generic handoff packages for agent/human nodes.
- `codex`: creates Codex dispatch packages.
- `claude-code`: creates Claude Code dispatch packages.
- `cao`: creates CAO dispatch packages with `allowedTools` derived from sLoom policy.

## Dispatch package layout

Agent executor modes create auditable files under the run directory:

```text
.sloom/runs/<run-id>/
  handoffs/<node-id>/
    task.md
    inputs.json
    expected-outputs.json
  dispatches/<node-id>/<adapter>/
    prompt.md
    dispatch.json
    status.json
    launch-cao.sh        # CAO only
```

sLoom pauses the run at `handoff-ready`. The external agent executes the frozen node and submits declared outputs with `sloom artifact put`.

## CAO adapter

The CAO adapter does not secretly start background agents inside sLoom's default path. It writes a launch spec and script:

```bash
sloom run <plan.json> --executor cao
sh .sloom/runs/<run-id>/dispatches/<node-id>/cao/launch-cao.sh
```

The generated CAO command includes:

- session name derived from the run and node;
- working directory;
- prompt file content;
- `--allowed-tools` flags mapped from the Skill policy.

Policy mapping:

| sLoom policy permission | CAO allowed tool |
| --- | --- |
| `filesystem.read` | `fs_read`, `fs_list` |
| `filesystem.write` | `fs_read`, `fs_list`, `fs_write` |
| `shell.readonly`, `shell.test` | `execute_bash` |
| `network.read`, `web.fetch` | `web_fetch` |

`@cao-mcp-server` is always included so workers can access CAO coordination primitives when available.

## Artifact contract remains mandatory

Agent output is not trusted just because it appears in a terminal. A node is complete only when every declared output has been submitted into `.sloom/runs/<run-id>/artifacts/manifest.json`:

```bash
sloom artifact put <run-id> <node-id> <artifact-name> ./artifact.md --executor cao
sloom resume <run-id> --executor cao
```

This keeps plan state, policy, and quality gates outside transient chat history.
