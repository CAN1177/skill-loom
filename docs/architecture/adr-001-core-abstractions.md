# ADR-001: Core abstractions

Date: 2026-07-15

## Status

Accepted for MVP.

## Context

The team has many useful engineering skills, but they are scattered as meta-skills. Simple development tasks should be automatically turned into a safe workflow without asking a model to improvise the entire process from chat history.

## Decision

sLoom separates the system into stable abstractions:

- **Skill**: reusable capability unit described by `SKILL.md` plus sidecar metadata.
- **Pack**: curated skill set and routing policy for a domain.
- **Blueprint**: workflow skeleton describing phases, artifacts, and gates.
- **Router**: recalls candidate skills from the catalog.
- **Planner**: assembles a minimal artifact DAG.
- **Validator**: checks dependencies, cycles, missing inputs, and policy risks.
- **Executor**: runs a frozen node using shell, Claude Code, Codex, or CAO.
- **Artifact**: named file-like contract between nodes.
- **Trace**: append-only run record for audit and evaluation.

Skill selection belongs to sLoom's catalog/router/planner layer, not to a multi-agent supervisor. Agent runtimes are execution adapters.

## Consequences

- Existing skills can be reused without rewriting prompts.
- Plans can be reviewed, diffed, validated, and approved before execution.
- Failure recovery becomes explicit: rerun a node, resume from artifacts, or replan.
- The MVP can start deterministic and local, then add LLM rerank and multi-agent execution later.
