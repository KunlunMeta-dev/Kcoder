# Lifecycle Hook Installation and Verification

Read this file only when the task involves creating, installing, migrating, or troubleshooting lifecycle hooks.

## Configuration Location and Trust

Hooks are not Git hooks, and there is no standalone `hook install` command. Installation consists of two parts: preparing a script or endpoint, then registering it in the `hooks` section of settings.

- User level: `<profile>/settings.json`
- Team project level: `.kcoder/settings.json`
- Machine private: `.kcoder/settings.local.json`

Project-level hooks should only be loaded after the user has explicitly confirmed the directory is trusted. Run `kcoder trust status --path <project>` first; do not auto-trust unfamiliar projects.

Hook discovery supports JSONC settings, including comments and trailing commas. The Studio user-Hooks editor accepts a JSON object; Hook process stdout still follows the strict JSON output contract below.

Studio Settings → Hooks can read, add, save and delete the selected target/account's user-level Hooks JSON. Writes are atomic and revision-checked; conflicts preserve the draft for review. Clearing this object removes user Hooks only, not project or plugin declarations. Plugin-owned Hooks stay read-only under plugin management. Changes apply to new conversations without restarting Studio; verify the relevant real event there.

## Events, Matchers, and Actions

Common events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `ConfigChange`, `CwdChanged`, and `FileChanged`. The configuration also accepts other `HookEvent` names, but not every runtime surface emits every event; you must verify with the real chain.

When the matcher is empty it matches everything; the query for tool events is typically the tool name. Prefer the smallest matcher to avoid one expensive hook intercepting all events.

Action types:

- `command`: run a local shell command.
- `prompt`: invoke the model to judge, generating extra tokens and Provider dependencies.
- `agent`: launch an independent Agent, with higher cost and permission impact.
- `http`: send HookInput JSON, introducing network and header credential risks.

## Command Hook Contract

Example configuration:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/to/post_tool_hook.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The command receives a JSON `HookInput` on stdin, containing event, `hook_event_name`, query, data, and additional context. At runtime, `KCODER_HOOK_EVENT` and `KCODER_HOOK_QUERY` are also provided.

Unix command hooks clear the inherited environment and only retain a controlled PATH, TERM, SHELL, PWD when available, and the hook variables above. Do not rely on the user's shell environment or API keys; when fixed non-sensitive parameters are needed, provide them explicitly in the script or a controlled wrapper. Windows retains only a set of system runtime variables, and likewise cannot assume any secret is inherited.

stdout must contain only one valid JSON object, and diagnostics go to stderr. Silent success is recommended:

```json
{"continue":true,"suppressOutput":true}
```

Block continuation:

```json
{"continue":false,"stopReason":"policy check failed","suppressOutput":true}
```

Permission events can return:

```json
{
  "reason": "command is outside the approved scope",
  "suppressOutput": true,
  "hookSpecificOutput": {
    "permissionDecision": "deny"
  }
}
```

`hookSpecificOutput` also supports `updatedInput`, `additionalContext`, `watchPaths`, and `worktreePath`, but these only take effect when the runtime consuming the event supports them. Do not inject untrusted hook output into context.

`async_hook: true` is suitable for pure notifications or external logging; subsequent stdout of the asynchronous process does not participate in the current event decision and cannot be used to perform permission blocking or input modification.

## Security and Verification

- Use absolute script paths, limited timeouts, and minimal privileges.
- Check the script's file modification, network access, subprocess, and credential reading behavior.
- `prompt` / `agent` hooks add model invocations; `http.headers` are plaintext literals. Explain the cost and secret risks to the user before enabling.
- Non-zero exit, timeouts, and invalid stdout are all failures; do not maintain flow by ignoring errors.

After modification:

1. `kcoder config validate`.
2. Run the command script independently with the saved HookInput.
3. Start a new session and run `/hooks` to confirm the event, matcher, source, and action.
4. Trigger a minimal real event to confirm the effect, rather than only seeing the configuration listed.

Unknown events may only produce warnings; JSON/schema validation passing does not mean the hook has executed.
