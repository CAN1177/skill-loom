# Contributing

Thanks for contributing to sLoom.

## Development

```bash
node packages/cli/bin/sloom.js --help
node packages/cli/bin/sloom.js init
node packages/cli/bin/sloom.js index examples/skills
node packages/cli/bin/sloom.js skills lint --strict
node --test
```

## Pull request expectations

- Keep skill selection deterministic where possible.
- Add or update examples for new plan/schema behavior.
- Do not add runtime network calls to core routing or validation.
- Policy checks should live in code, not only in prompts.
- Prefer small, composable modules.

## Adding a skill

1. Add or reference an existing `SKILL.md`.
2. Add `skillforge.json` with inputs, outputs, execution metadata, policy, and routing fields.
3. Run `sloom index <path>` and `sloom skills lint --strict`.
4. Add the skill to a pack only when it is safe for that domain.
