# Runtime Policies and Task Budgets

Read only for channel limits, independent-session communication, Goal-Pro or project-guide initialization errors. These are target-owned policies, not client UI preferences.

## Channel task budget

`integrations.core.channelTaskBudget` sets an explicit task budget for native channels/business tasks. It is optional; absence or null preserves the existing default policy. Example settings (not a request to change them):

```json
{
  "integrations": {
    "core": {
      "channelTaskBudget": {"tokens": 65536, "modelCalls": 6, "runMillis": 240000}
    }
  }
}
```

`tokens` is required, 1–1,000,000. `modelCalls` is 1–8 (default 8), and `runMillis` is 1,000–240,000 (default 240,000). Without an explicit budget, the existing policy is 32,768 tokens and 240 seconds; tool tasks allow up to eight model calls, while a plain single-turn task makes one call with its existing 30-second limit. Initialization counts against the task budget, not that separate call window. Usage covers request/tool-definition input and may conservatively reserve tokens when the provider omits usage.

Use the target's schema-backed settings editor or the matching CLI scope; do not invent a Config-tool path if discovery does not offer it. A larger budget does not grant tools or override stricter account/organization limits. An admitted task pins its budget, and dispatch rechecks current authority; settings changes are not a promise to extend a running task.

## Independent-session communication policy

Tools being selected is not permission to send or wake another session. `cross_session_messages` is read only from the actual target profile's user settings. Project/local/CLI overlays cannot enable this account policy. Defaults keep both communication and idle wake disabled:

```json
{
  "cross_session_messages": {
    "enabled": false,
    "wake_idle": false,
    "message_ttl_seconds": 86400,
    "max_messages_per_minute": 32,
    "max_source_messages_per_minute": 8
  }
}
```

Change only the user-requested fields in the owning profile, using the supported account policy UI or user-scope configuration. `wake_idle` is a separate side effect; never turn it on merely to make a tool available. TTL is 1–604800 seconds and the two rate limits are each 1–256. A received message's expiry and original operation identity remain fixed; a retry must not create a new ID or extend TTL. A rate or wake-budget rejection is not a model output-limit problem. See [studio.md](studio.md#independent-session-messages) for original-receipt reconciliation; `applied` means history append, not model completion.

## Goal-Pro Limit Parameters

Goal-Pro has three independent kinds of limits; do not confuse them because their names are similar:

- `goal_max_auto_continuations` defaults to `8` and only limits the number of automatic continuations of the parent Goal runner; it does not limit the internal turns of a single verifier, nor does it count rejected completion requests.
- `goal_pro.verifier_max_turns` defaults to `64` and only limits the number of turns usable inside one independent verifier run; it does not limit parent Goal continuations and is not a cumulative rejection threshold.
- `goal_pro.completion_rejection_limit` defaults to `8` with a minimum of `1`. It cumulatively counts deterministic completion-gate rejections (e.g., recent tests still failing, missing or invalid Answer report) and semantic `FAIL` / `FLAKY` returned by an independent verifier or a real machine acceptance gate; when the threshold is reached, the Goal transitions to `blocked` and the runner stops. Input format errors, stale results, `InfrastructureError`, Provider call failures, protocol errors, invalid verdicts, and exhausted turns do not count toward this cumulative value.

When a Goal-Pro is created, the current `goal_pro.verifier_max_turns` and `goal_pro.completion_rejection_limit` values are frozen into that Goal. Subsequent settings changes only affect newly created Goal-Pros and do not retroactively change existing ones. If a Goal persisted from an older version lacks the `completion_rejection_limit` field, it retains the original unlimited semantics and does not automatically pick up the default value of `8`.

First view the final value and its source, then write to the appropriate scope as needed:

```bash
kcoder config get goal_max_auto_continuations --source
kcoder config get goal_pro.verifier_max_turns --source
kcoder config get goal_pro.completion_rejection_limit --source

kcoder config set goal_max_auto_continuations 8 --scope user
kcoder config set goal_pro.verifier_max_turns 64 --scope user
kcoder config set goal_pro.completion_rejection_limit 8 --scope user
```

These parameters are normal settings, not credentials. Do not write API keys, tokens, or other Provider credentials into commands, configuration examples, project files, or skill bodies; use `kcoder auth` for authentication.

## Project guide initialization

Guide loading happens before session/extensions initialize: at most 4 MiB of UTF-8 per file, 16 MiB total and 128 files. For `project_instruction_limit`, `project_instruction_read` or `project_instruction_encoding`, fix the named guide and restart initialization. Never work around it by running without part of the instructions. Current-directory AGENTS.md remains authoritative; supported central-guide links do not authorize rewriting unrelated paths. Skill-package limits are independent; see [skills.md](skills.md#complete-skill-resource-loading).
