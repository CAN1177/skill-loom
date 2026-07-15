# sLoom Orchestrator Entry Skill

Use this skill when a user describes a non-trivial engineering task that benefits from a repeatable workflow: requirements analysis, repository exploration, implementation, regression testing, review, or release handoff.

sLoom is an open-source Skill-first orchestrator CLI. It does not replace Claude Code, Codex, shell, or CAO; it plans and traces which Skill should run, what artifact it must consume, and what artifact it must produce.

## When to use

Use sLoom when the user asks to:

- analyze a requirement and then implement it;
- fix a bug with repo exploration, targeted change, tests, and review;
- turn a vague task into a frozen workflow plan;
- run a team-defined engineering process backed by local `SKILL.md` files;
- continue or resume a previous `.sloom/runs/<run-id>` workflow.

For one-line trivial edits, normal direct execution may be faster. For multi-step development work, prefer sLoom.

## Standard flow

From the project root:

```bash
sloom init
sloom index examples/skills
sloom plan --task "<user task>" --blueprint feature --out .sloom/plans/<task-slug>.json
sloom validate .sloom/plans/<task-slug>.json
sloom run .sloom/plans/<task-slug>.json --executor auto
```

Use `--blueprint bugfix` for bug fixes. If `sloom` is not installed globally, use:

```bash
node packages/cli/bin/sloom.js <command>
```

## Handling handoff-ready nodes

If a node becomes `handoff-ready`, do not edit `plan.lock.json` or `run-state.json` by hand.

1. Read the generated task:

   ```bash
   sloom runs
   cat .sloom/runs/<run-id>/handoffs/<node-id>/task.md
   ```

2. Execute only that frozen node contract.
3. Write the expected Markdown artifact to a normal file.
4. Submit it back:

   ```bash
   sloom artifact put <run-id> <node-id> <artifact-name> <file> --executor codex
   sloom resume <run-id> --executor auto
   ```

Repeat until the DAG succeeds or a real blocker is documented in an artifact.

## CAO adapter flow

For CLI Agent Orchestrator (CAO) dispatch:

```bash
sloom run .sloom/plans/<task-slug>.json --executor cao
sh .sloom/runs/<run-id>/dispatches/<node-id>/cao/launch-cao.sh
cao session status <session-name> --workers
```

The CAO worker must still submit outputs through:

```bash
sloom artifact put <run-id> <node-id> <artifact-name> <file> --executor cao
sloom resume <run-id> --executor cao
```

CAO terminal output is not a trusted final artifact until it is submitted into the sLoom artifact manifest.

## Safety rules

- Treat `plan.lock.json`, `run-state.json`, `events.jsonl`, and artifact manifests as sLoom-owned runtime state.
- Do not run destructive commands unless the user explicitly asks and the local agent policy allows it.
- Do not `git push` unless the user explicitly asks.
- Keep edits scoped to the active handoff node.
- If blocked, submit a Markdown artifact explaining the blocker instead of silently skipping the node.
