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
2. Prefer a non-invasive metadata overlay under `.sloom/overlays/skills/` or `packs/<pack>/skills/` with inputs, outputs, execution metadata, policy, and routing fields.
3. Use a same-directory `sloom.json` only when you own the skill and intentionally want to ship portable metadata with it.
4. Run `sloom index <path>` and `sloom skills lint --strict`.
5. Add the skill to a pack only when it is safe for that domain.
