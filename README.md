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
- example skills, pack, blueprint, and workflow plan

SQLite/FTS, LLM rerank, Claude Code/Codex real execution, worktree isolation, and CAO adapter are planned next milestones.

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

# Index example skills with pack overlays
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
packs/               curated skill sets, routing policies, and metadata overlays
schemas/             JSON Schemas for metadata overlays and plans
examples/            example skills and plans
docs/                architecture notes and roadmap
```

## Skill metadata overlay

sLoom should not mutate your existing local skills by default. Treat `SKILL.md` directories as read-only source assets, then store orchestration metadata in the project workspace or in a pack:

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
- implement shell executor with command policy checks
- add Claude Code executor adapter
- add git worktree isolation and resumable run state
- create routing / planning eval datasets

## License

MIT
