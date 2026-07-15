# sLoom Team Adoption Guide

This guide is for introducing sLoom to a team that already has useful local `SKILL.md` files, but lacks a repeatable way to choose, combine, execute, and evaluate them.

## One-sentence pitch

sLoom turns scattered engineering Skills into a reviewable Artifact DAG: the agent can still write code, but skill selection, policy, state, and quality gates become visible and measurable.

## 10-minute demo

From the repository root:

```bash
node packages/cli/bin/sloom.js init
node packages/cli/bin/sloom.js index examples/skills
node packages/cli/bin/sloom.js route "修复资源列表搜索为空时报错"
node packages/cli/bin/sloom.js plan --task "修复资源列表搜索为空时报错" --blueprint bugfix --out .sloom/plans/demo-bugfix.json
node packages/cli/bin/sloom.js graph .sloom/plans/demo-bugfix.json
node packages/cli/bin/sloom.js run .sloom/plans/demo-bugfix.json --executor auto
```

What to point out:

1. The plan is frozen before execution.
2. Each node declares input and output artifacts.
3. Safe shell nodes run with policy checks.
4. Agent nodes pause at `handoff-ready` instead of secretly editing code.
5. A real agent must submit declared artifacts through `sloom artifact put`.

## Evaluation demo

```bash
node packages/cli/bin/sloom.js eval evals/development-flow.json
```

The report answers three practical questions:

- Did routing put the expected Skills in top candidates?
- Did planning create the expected Artifact DAG?
- How much prompt pollution was reduced by activating only the selected Skills instead of the whole catalog?

## Rollout checklist

1. Pick 5-10 high-value team Skills.
2. Run `sloom scan` and generate non-invasive overlays.
3. Review outputs, required inputs, executor preference, and policy for every Skill.
4. Add 5 real historical tasks to `evals/` as golden cases.
5. Run `sloom eval` before changing routing, packs, or overlays.
6. Demo one bugfix and one feature workflow to the team.
7. Adopt `sloom artifact put` as the boundary between agent work and trusted workflow state.

## Metrics to track

| Metric | Why it matters | MVP source |
| --- | --- | --- |
| Route top-3 recall | Whether the right Skill is discoverable | `sloom eval` |
| Plan skill recall | Whether the DAG contains required Skills | `sloom eval` |
| Artifact coverage | Whether expected deliverables are represented | `sloom eval` |
| Prompt pollution reduction | How many Skills were not loaded into the active task | `sloom eval` |
| Human intervention count | How often work pauses for handoff/artifact submission | `sloom eval`, run state |
| Recovery success | Whether paused/failed runs can resume | `sloom resume`, run state |

## Recommended positioning

Do not sell sLoom as “another agent platform.” Position it as the workflow and evidence layer for agents:

```text
Human intent -> sLoom Skill Catalog -> Frozen Plan -> Agent/Shell execution -> Artifacts -> Reviewable trace
```

The strongest message for engineers is control: plans are inspectable, policies are explicit, and outputs are files with checksums instead of hidden chat history.
