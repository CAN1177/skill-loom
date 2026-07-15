# sLoom

**sLoom** (`sloom`) is an **open-source**, skill-first orchestrator CLI for turning scattered engineering `SKILL.md` files into routable, reviewable, executable workflows.

[中文文档](README.zh-CN.md)

The core idea is simple:

> **Skill is the first abstraction.** Claude Code, Codex, shell, and multi-agent runtimes are execution backends, not the place where workflow policy lives.

```text
Task / Issue
  -> Skill Catalog
  -> Router
  -> Blueprint Planner
  -> DAG Validator
  -> Deterministic Executor
  -> Artifacts + Gates + Trace
```

## Current status

This repository contains the first open-source MVP scaffold:

- zero-dependency Node.js 22 CLI
- local skill indexer for `SKILL.md` plus non-invasive metadata overlays
- catalog linter
- lexical router with pack filtering
- bugfix / feature blueprints
- artifact DAG planner
- plan validator
- Mermaid graph output
- dry-run trace writer
- workflow artifact runtime with resumable run state
- safe shell executor and agent handoff runtime
- Codex / Claude Code / CAO dispatch packages
- example skills, pack, blueprint, and workflow plan

SQLite/FTS, LLM rerank, direct opt-in subprocess execution, worktree isolation, richer CAO log harvesting, and stricter gates are planned next milestones.

## Quick start

```bash
# Node.js 22+
node packages/cli/bin/sloom.js --help

# Initialize local state
node packages/cli/bin/sloom.js init

# Scan example skills into a non-invasive inventory
node packages/cli/bin/sloom.js scan examples/skills

# Propose missing overlays without mutating skill directories
node packages/cli/bin/sloom.js propose --from .sloom/inventory.json

# Review, then apply overlays into .sloom/overlays with a rollback backup
node packages/cli/bin/sloom.js apply .sloom/proposals/overlays.json --yes --backup
# node packages/cli/bin/sloom.js rollback <backup-id>

# Index example skills with pack overlays
node packages/cli/bin/sloom.js index examples/skills

# Inspect catalog
node packages/cli/bin/sloom.js skills list
node packages/cli/bin/sloom.js skills lint

# Route a task
node packages/cli/bin/sloom.js route "修复资源列表搜索为空时报错" --json

# Generate a plan
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/search-empty-bug.json

# Validate, graph, dry-run, and execute with artifact runtime
node packages/cli/bin/sloom.js validate .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js graph .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --dry-run
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json

# P3/P4: run with safe-shell, handoff, or dispatch adapters
node packages/cli/bin/sloom.js executors
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor auto
# node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor cao
node packages/cli/bin/sloom.js runs
# node packages/cli/bin/sloom.js artifact put <run-id> <node-id> <artifact-name> <file>
# node packages/cli/bin/sloom.js resume <run-id> --executor auto
```

If installed as a package, the binary name is `sloom`.

## Workflow execution and artifacts

`sloom run` now creates a durable run directory under `.sloom/runs/<run-id>`:

```text
.sloom/runs/<run-id>/
  plan.lock.json
  run-state.json
  events.jsonl
  artifacts/
    manifest.json
    <node-id>/<artifact-name>.md
```


P3/P4 run directories may also include agent handoff and dispatch packages:

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

This keeps sLoom usable inside Claude CLI or Codex CLI today: sLoom owns routing, plan locking, policy, state, events, and artifacts; the surrounding agent executes the generated handoff task and submits the result. See [Agent Integration](docs/agent-integration.md) and the optional [sLoom Entry Skill](skills/sloom-orchestrator/SKILL.md).

The default local runtime is deterministic and safe: it does not mutate source files. It materializes each node output as a traceable artifact so the workflow can be inspected and resumed.

P3 added explicit executor adapter mode. `--executor auto` runs policy-approved shell nodes with a small safe-command allowlist, and turns Codex / Claude Code nodes into durable handoff packages instead of secretly spawning agents or mutating your code. P4 extends this into provider dispatch packages: `--executor codex`, `--executor claude-code`, and `--executor cao` create auditable launch prompts/specs, with CAO `allowedTools` derived from sLoom policy. A real agent can complete the node, write a Markdown artifact, submit it back with `sloom artifact put`, and then `sloom resume --executor auto|cao` continues the DAG.

Useful commands:

```bash
node packages/cli/bin/sloom.js executors
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --max-nodes 2
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor auto
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --executor cao
sh .sloom/runs/<run-id>/dispatches/<node-id>/cao/launch-cao.sh
node packages/cli/bin/sloom.js artifact put <run-id> analysis requirement.spec ./requirement.spec.md --executor cao
node packages/cli/bin/sloom.js resume <run-id> --executor cao
node packages/cli/bin/sloom.js runs --json
```


## Repository layout

```text
packages/
  core/              catalog, routing, planning, validation, graph utilities
  cli/               command-line entry point
blueprints/          workflow skeletons: bugfix, feature
packs/               curated skill sets, routing policies, and metadata overlays
schemas/             JSON Schemas for metadata overlays and plans
examples/            example skills and plans
docs/                architecture notes, agent integration, and roadmap
skills/              optional sLoom Entry Skill for agent natural-language use
```

## Skill metadata overlay

sLoom should not mutate your existing local skills by default. The `scan -> propose -> apply --backup` workflow keeps every metadata change reviewable and reversible. Treat `SKILL.md` directories as read-only source assets, then store orchestration metadata in the project workspace or in a pack:

```text
# Existing skill, read-only
~/.claude/skills/my-skill/
  SKILL.md

# sLoom-owned orchestration metadata
.sloom/overlays/skills/implementation.targeted-fix.json

# Or a shared/open-source pack overlay
packs/frontend-delivery/skills/implementation.targeted-fix.json
```

A same-directory `sloom.json` remains supported only as an optional portable metadata file when the skill author intentionally ships it with the skill. It is not the default governance model for existing local skills.

Minimal overlay shape:

```json
{
  "apiVersion": "sloom.dev/v1alpha1",
  "kind": "SkillOverlay",
  "metadata": {
    "id": "implementation.targeted-fix",
    "version": "1.0.0",
    "title": "Targeted Fix Implementation",
    "source": {
      "type": "local-skill",
      "path": "examples/skills/targeted-fix",
      "fingerprint": "sha256:..."
    }
  },
  "spec": {
    "intents": ["bugfix", "feature"],
    "capabilities": ["implementation", "small-change"],
    "inputs": { "required": ["repo.context"], "optional": ["requirement.spec"] },
    "outputs": ["source.diff", "implementation.summary"],
    "execution": { "preferredExecutor": "claude-code", "workspace": "isolated-worktree", "timeoutMinutes": 40 },
    "policy": { "risk": "medium", "permissions": ["filesystem.write", "git.diff"], "denyCommands": ["rm -rf", "git push"] },
    "routing": { "includeKeywords": ["修复", "bug", "实现"], "tags": ["implementation"] }
  }
}
```

## Design principles

1. **Artifact-first**: nodes pass named artifacts, not hidden chat history.
2. **Plan before run**: the DAG must be frozen and validated before execution.
3. **Minimal closed DAG**: choose only the smallest set of skills needed to satisfy artifact dependencies.
4. **Policy as code**: permissions, command deny-lists, gates, and approval points must be enforceable outside prompts.
5. **Executors are adapters**: Claude Code, Codex, shell, and CAO execute planned nodes; they do not own skill selection.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the full plan. The next implementation milestones are:

- replace JSON catalog with SQLite + FTS5
- add stricter schema validation
- support YAML round-trip for plans and metadata overlays
- add opt-in real subprocess/session monitoring for Codex, Claude Code, and CAO
- add git worktree isolation
- create routing / planning eval datasets

## License

MIT
