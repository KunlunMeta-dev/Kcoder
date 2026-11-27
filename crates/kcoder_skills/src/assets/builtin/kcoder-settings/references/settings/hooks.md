# Lifecycle Hook Installation and Verification

Read this file only when the task involves creating, installing, migrating, or troubleshooting lifecycle hooks. Background: `docs/hooks.md`, `docs/security.md`.

## Configuration Location and Trust

Hooks are not Git hooks, and there is no standalone `hook install` command. Installation consists of two parts: preparing a script or endpoint, then registering it in the top-level `hooks` object of settings (`{"<Event>": [{"matcher": "...", "hooks": [<action>, ...]}]}`).

Hook discovery reads only these files and appends their rules (no override or deduplication across files):

- User level: `<profile>/settings.json` (the profile resolved from `KCODER_CONFIG_DIR`/`KCODER_HOME`)
- Team project level: `<cwd>/.kcoder/settings.json`
- Machine private: `<cwd>/.kcoder/settings.local.json`

`--settings-file` overlays and the executable-directory settings file are not hook sources; a `hooks` object placed there is not loaded. Enabled plugins contribute their own hooks.

Project-level hooks load only when the working directory is trusted, and execution is refused if that trust is later revoked. Run `kcoder trust status --path <project>` first; do not auto-trust unfamiliar projects.

Hook discovery supports JSONC settings, including comments and trailing commas. Rules are parsed one by one: valid sibling rules still load, while a malformed rule or action fails closed (its event, limited to its matcher when that parses, reports a hook error every time; for `PreToolUse` the matching tool is blocked). An unreadable file or a non-object `hooks` section fails every event closed. Unknown event names are reported as errors and ignored. Diagnostics name the file and JSON location (for example `hooks.PreToolUse[1].hooks[0]`) without echoing values, and appear in the TUI startup notice and `/hooks`. `kcoder config validate` checks these files with the same parser and fails on any hook error.

Studio Settings → Hooks can read, add, save and delete the selected target/account's user-level Hooks JSON. It validates event names, action types and their fields, a 256 KiB size limit and at most 512 actions; writes are atomic and revision-checked, and conflicts preserve the draft for review. Clearing this object removes user Hooks only, not project or plugin declarations. Plugin-owned Hooks stay read-only under plugin management. Changes apply to new conversations without restarting Studio; verify the relevant real event there.

## Events, Matchers, and Actions

Commonly emitted events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `ConfigChange`, `CwdChanged`, and `FileChanged`. Event keys accept PascalCase or snake_case (`pre_tool_use`). The `HookEvent` enum also accepts other names (for example `Setup`, `Notification`, `InstructionsLoaded`, `TaskCreated`, `WorktreeCreate`), but not every runtime surface emits every event; verify with the real chain.

`Stop` runs only after the model stops requesting tools for the turn, not after every model response; use `PreToolUse` to check or block a tool before it runs.

The matcher is compared with the event query (the tool name for tool events):

- missing, empty or `*` matches everything;
- `A|B|C` matches any listed value exactly;
- a pattern starting with `^` is a regular expression;
- anything else is an exact, case-sensitive match.

KCoder's built-in tool names are mostly lowercase (`bash`, `read`, `write`, `edit`, `grep`, `glob`, `skill`), so a `Bash` matcher copied from another host does not match. Command actions may add an `if` rule (`ToolName` or `ToolName(text)`, tool name case-insensitive, text matched as a substring of the input JSON). Prefer the smallest matcher to avoid one expensive hook intercepting all events.

Action types:

- `command`: run `command` through `shell` (default `bash`, `powershell.exe` on Windows); `timeout` defaults to 600 seconds.
- `http`: send HookInput JSON to `url` (`method` default `POST`; GET/PUT/PATCH/DELETE also accepted); `timeout` defaults to 600 seconds. A non-2xx status or a non-JSON body is a failure.
- `prompt` / `agent`: one tool-less model call with `prompt` / `instructions` (default timeout 30 / 60 seconds; no multi-turn agent is spawned, and `agent.max_turns` is unsupported: it still loads but is ignored and reported as a warning). Both require an explicit `model`. The transport is chosen from the model name and reads only the host process environment (`ANTHROPIC_*`, `GEMINI_*`, otherwise `OPENAI_BASE_URL`/`OPENAI_API_KEY`), never KCoder Provider credentials; missing values are a hook error. The model must answer `{"ok":true}` or `{"ok":false,"reason":"..."}`; `false` blocks.

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
            "command": "/usr/bin/python3 /absolute/path/to/post_tool_hook.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The command receives a JSON `HookInput` on stdin: `event` (snake_case), `hook_event_name` (PascalCase), `query`, `data`, `session_id`, `cwd` and `permission_mode`. Tool events add `tool_name` and `tool_input`; `PostToolUse` adds `tool_output` and `is_error`; `UserPromptSubmit` adds `prompt`. At runtime, `KCODER_HOOK_EVENT` and `KCODER_HOOK_QUERY` are also provided. Command templates may use `$ARGUMENTS` (the whole JSON) or `{{query}}`, `{{data.<path>}}`, `{{extra.<field>}}`; values are passed through environment variables and expanded once, and templates with placeholders reject complex shell constructs (see `docs/hooks.md`).

Unix command hooks clear the inherited environment: PATH is fixed to `/usr/local/bin:/usr/bin:/bin`, plus TERM, SHELL, PWD when a cwd is known, and the hook variables above; HOME and API keys are not inherited. Use absolute interpreter paths (a `node` under nvm or Homebrew is usually not found) and do not rely on the user's shell environment; when fixed non-sensitive parameters are needed, provide them explicitly in the script or a controlled wrapper. Windows retains only a fixed set of system runtime variables (including PATH), and likewise cannot assume any secret is inherited. Plugin hooks additionally receive the plugin-root variables described in [plugins.md](plugins.md).

Exit status 0 with empty stdout is a silent success. Non-empty stdout must be exactly one JSON object; send diagnostics to stderr. Plain JSON fields: `continue`, `stopReason`, `suppressOutput`, `reason`, `systemMessage`, `hookSpecificOutput`.

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

`permissionDecision` accepts `allow`, `ask` or `deny`; across hooks the result is deny > ask > allow. A `PreToolUse` `allow` skips the normal permission decision for that call (treat it as a permission grant), except that tools requiring explicit approval still ask. `hookSpecificOutput` also supports `updatedInput`, `additionalContext`, `watchPaths`, and `worktreePath`, but these only take effect when the runtime consuming the event supports them. Do not inject untrusted hook output into context.

`async_hook: true` is suitable for pure notifications or external logging; it returns immediately, and the asynchronous process's later stdout does not participate in the current event decision, so it cannot perform permission blocking or input modification.

## Security and Verification

- Use absolute script paths, limited timeouts, and minimal privileges. Hook output is capped at 1 MiB.
- Check the script's file modification, network access, subprocess, and credential reading behavior.
- `prompt` / `agent` hooks add model invocations; `http.headers` are plaintext literals in settings. Explain the cost and secret risks to the user before enabling.
- Non-zero exit, timeouts, and invalid stdout are all failures; for `PreToolUse` such a failure denies the tool. Do not maintain flow by ignoring errors.

After modification:

1. `kcoder config validate` (file syntax, the main schema, and hook rules in the three hook files above; warnings such as `agent.max_turns` do not fail it).
2. Run the command script independently with a saved HookInput.
3. Start a new session and run `/hooks` to confirm the event, matcher, source, and action.
4. Trigger a minimal real event to confirm the effect, rather than only seeing the configuration listed.

Validation passing does not mean the hook has executed.
