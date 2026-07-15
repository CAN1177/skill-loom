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
- local skill indexer for `SKILL.md` + `sloom.json`
- catalog linter
- lexical router with pack filtering
- bugfix / feature blueprints
- artifact DAG planner
- plan validator
- Mermaid graph output
- dry-run trace writer
- example skills, pack, blueprint, and workflow plan

SQLite/FTS, LLM rerank, Claude Code/Codex real execution, worktree isolation, and CAO adapter are planned next milestones.

## Quick start

```bash
# Node.js 22+
node packages/cli/bin/sloom.js --help

# Initialize local state
node packages/cli/bin/sloom.js init

# Index example skills
node packages/cli/bin/sloom.js index examples/skills

# Inspect catalog
node packages/cli/bin/sloom.js skills list
node packages/cli/bin/sloom.js skills lint

# Route a task
node packages/cli/bin/sloom.js route "修复资源列表搜索为空时报错" --json

# Generate a plan
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/search-empty-bug.json

# Validate, graph, and dry-run
node packages/cli/bin/sloom.js validate .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js graph .sloom/plans/search-empty-bug.json
node packages/cli/bin/sloom.js run .sloom/plans/search-empty-bug.json --dry-run
```

If installed as a package, the binary name is `sloom`.

## Repository layout

```text
packages/
  core/              catalog, routing, planning, validation, graph utilities
  cli/               command-line entry point
blueprints/          workflow skeletons: bugfix, feature
packs/               curated skill sets and routing policies
schemas/             JSON Schemas for sidecars and plans
examples/            example skills and plans
docs/                architecture notes and roadmap
```

## Skill sidecar

sLoom does not require rewriting existing `SKILL.md` files. Add a sidecar next to each skill:

```text
my-skill/
  SKILL.md
  sloom.json
```

Minimal sidecar shape:

```json
{
  "apiVersion": "sloom.dev/v1alpha1",
  "kind": "Skill",
  "metadata": {
    "id": "implementation.targeted-fix",
    "version": "1.0.0",
    "title": "Targeted Fix Implementation",
    "skillPath": "examples/skills/targeted-fix"
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
- support YAML round-trip for plans and sidecars
- implement shell executor with command policy checks
- add Claude Code executor adapter
- add git worktree isolation and resumable run state
- create routing / planning eval datasets

## License

MIT
