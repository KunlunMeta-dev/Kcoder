# KCoder Skill Authoring Best Practices

Skills are compact operating guides for repeatable work. They should help a future KCoder agent decide when to load the skill, what to do first, how to verify progress, and where to find deeper references without flooding the main context.

## Keep the trigger precise

The `description` field is loaded before the skill body. Make it answer one question: when should this skill be selected?

Prefer:

```yaml
description: Use when diagnosing flaky Rust tests or nondeterministic cargo test failures.
```

Avoid descriptions that summarize the whole workflow. If the metadata sounds complete, an agent may act from the summary instead of reading the skill.

## Put workflow in the body

Use the body for ordered procedures, decision points, and verification gates. Good skills usually include:

- A short applicability statement.
- A step-by-step workflow.
- Required checks before claiming completion.
- Known failure modes.
- Links to one-level-deep reference files.

## Use progressive disclosure

Keep `SKILL.md` short. Move large tables, examples, schemas, command catalogs, or domain references into `references/*.md`. Link those files from the main skill and tell the agent exactly when to read each one.

Reference files should be one level deep from `SKILL.md`. Avoid nested chains where a reference points to another reference that must also be loaded.

## Make scripts deterministic

When a skill needs validation, prefer a checked-in script over asking the agent to improvise a validator each time. Scripts should:

- Fail with actionable error messages.
- Print the exact file or field that needs attention.
- Avoid hidden network or filesystem assumptions.
- Be safe to rerun.

## Write for small models too

Use explicit JSON shapes, command examples, and short negative examples for common mistakes. When a step must not be skipped, say so directly and place it near the action that needs it.

## Test the skill

Validate a skill with realistic prompts before treating it as stable:

1. Run a task without the skill and note the failure mode.
2. Add or update the skill.
3. Run a fresh session using the skill.
4. Check whether the agent loaded the right references, followed the workflow, and verified the result.
5. Tighten metadata or steps based on observed behavior.

## Checklist

- [ ] `name` is short and stable.
- [ ] `description` states when to load the skill.
- [ ] Body contains the actual workflow.
- [ ] Large material lives under `references/`.
- [ ] Verification steps are explicit.
- [ ] Examples use KCoder paths and tool names.
- [ ] No product-specific or external-agent branding leaks into the skill.

