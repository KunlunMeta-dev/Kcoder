# Training Session Configuration Isolation

Read this file only when the task involves trajectory training, benchmark harness, or the need to forbid historical memory from affecting sampling.

## Current Boundaries

`--training-mode` is a runtime switch and cannot be enabled via `"training_mode": true` in settings. It disables retries, auto-summarization, memory observer, and other non-task-essential background Provider requests, but current related-memory injection points will not be automatically skipped just because of training mode.

Training sessions also use an empty plugin snapshot at runtime: plugin skills are not loaded, plugin hooks do not execute, and plugin MCP is neither started nor connected. The built-in `kcoder-settings` is removed from that session's Skill registry, but the materialized files on disk remain, and normal sessions continue using them. Plugin management commands such as install, enable/disable, and uninstall are themselves unaffected.

Therefore, for clean training trajectories, both `--training-mode` and a memory-free settings overlay should be used, and a brand-new session should be started. Do not resume a transcript that already contains `<relevant-memories>`; turning off configuration does not delete existing messages.

## Recommended Read-Only Overlay

Create an independent `setting_training.jsonc`; do not modify the daily user settings:

```jsonc
{
  "auto_memory_enabled": false,
  "auto_tool_memory_enabled": false,
  "memory": {
    "structured_enabled": false,
    "legacy_prompt_enabled": false,
    "observer_mode": "disabled"
  },
  "session_memory": {
    "enabled": false,
    "update_enabled": false,
    "compact_enabled": false
  }
}
```

This overlay does not declare `providers`, so it does not trigger the complete list ownership semantics of explicit Provider files. For training:

```bash
kcoder \
  --training-mode \
  --settings-file /absolute/path/to/setting_training.jsonc \
  --provider <provider> \
  "<prompt>"
```

## Pre-Launch Verification

```bash
kcoder --settings-file /absolute/path/to/setting_training.jsonc \
  config get memory.structured_enabled

kcoder --settings-file /absolute/path/to/setting_training.jsonc \
  config get memory.legacy_prompt_enabled

kcoder --settings-file /absolute/path/to/setting_training.jsonc \
  config validate
```

Both `get`s must output `false`. If the training request records still contain `<relevant-memories>`, first confirm that no old session was resumed, that the overlay path belongs to the actual launch command, and that there is no higher-priority CLI/environment override.

## Other Extensions That Affect Trajectories

Training mode is not equal to an empty runtime: non-plugin MCP, non-plugin skills, command/HTTP lifecycle Hooks, project instructions, and trust status explicitly configured in settings can still change the tool set, context, or side effects; prompt/agent Hooks are filtered per the existing training mode rules. When repeatable benchmarks are needed:

- Use a fixed cwd and an explicit `--tool-profile`.
- Pin and record `--settings-file`, Provider, model, and reasoning effort.
- Review project `.kcoder/settings.json`, `.kcoder/settings.local.json`, `.kcoder/skills`, and non-plugin hooks; do not assume these independent extensions are turned off just because plugins are disabled.
- When project extensions are not needed, use an isolated controlled workspace/profile; do not "fix" missing tools by auto-trusting unfamiliar directories.
- Provider keys use `--credential-env-file` or controlled environment, not written into the training overlay.

Configuration only blocks new memory reads/writes; it does not clean existing SQLite memory or historical session files.
