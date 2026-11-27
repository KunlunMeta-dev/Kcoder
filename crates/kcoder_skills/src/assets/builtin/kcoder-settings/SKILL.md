---
name: kcoder-settings
description: Configure or diagnose KCoder models, credentials, tool selections, Wiki, channels, peer communication, extensions and TUI preferences. Confirm the actual target/account, discover supported settings, make the smallest authorized change and verify its activation. Not for unrelated terminal troubleshooting.
metadata:
  kcoder:
    category: configuration
    tags: [settings, configuration, provider, model, reasoning, studio, remote, wiki, knowledge, retry, permissions, credentials, jsonc, mcp, searxng, playwright, tools, kworker, skills, hooks, plugins, marketplace, tui, clipboard, copy, markdown, theme, outline, navigation, evolution, rating]
---

# KCoder Configuration Management

## Identify the owner before changing anything

1. Determine the selected execution target, KCoder account, workspace, running build and effective configuration sources. A Gateway login is not target-account or Provider authentication. A local display identity is not proof of remote authentication.
2. Separate target execution settings, Gateway connection/authentication data and this client's UI preferences. A remote model belongs to its target/account; copying its key into the local client is not the default repair.
3. For explanation or diagnosis, stay read-only. Initialization, import, migration, trust changes, credential migration, enabling tools and restarting services are mutations, not diagnostic prerequisites. When the user has authorized a specific change, complete it without adding redundant approval steps.
4. Preserve unrelated settings and concurrent changes. Never replace/reset/move a Home, clear credentials/history, broadly enable tools or overwrite an entire configuration to fix one field.

## Find the authoritative setting

When the current tool list includes `Config`, use its non-mutating discovery before guessing paths or types:

```json
{"action":"list","setting":"knowledge"}
```

```json
{"action":"describe","setting":"knowledge.retrieval_enabled"}
```

```json
{"setting":"knowledge.retrieval_enabled"}
```

`list`/`describe` do not read credentials or write configuration. To read, omit `value`; explicit null is a clear operation, not a read. A write uses `action:value` (or omits action), `setting` and the typed `value` only after checking support and the user's intended change. Config has no invented `scope` argument: its writes use the host-bound user settings path. Some keys are read-only or startup-only, and not every settings-file field is exposed by Config.

If Config is unavailable, or the task needs a file scope/source or an unsupported key, use the actual target's CLI or schema-backed settings UI. `kcoder` below is a command placeholder: use the CLI entry supplied by the skill activation context, preserving its explicit Home, cwd and overlays. Do not assume an installed `kcoder` or `kcoder-dev` on PATH owns the selected running target.

```bash
kcoder config path
kcoder config get permission_mode --source
kcoder config validate
```

Inspect only relevant fields; `config list --sources` is available for source diagnosis, but do not paste an entire configuration or environment into chat/logs.

## Choose the matching reference

Read only the needed guide with the existing `read` tool. Resolve these paths against the **Skill base directory** returned at activation; do not search unrelated Homes or change the project cwd. Missing read access is a limitation, not permission to bypass the sandbox. Supporting guides live below `references/settings/` and are not automatically injected by the ordinary immediate-reference loader.

| Need | Read first |
| --- | --- |
| Provider/model, model discovery, context window, output limits, reasoning, extra body or credential backend | [providers.md](references/settings/providers.md) |
| Tool profiles, default-disabled tools, Studio KCoder/KWorker choices, expert/Luna allowlists, file-edit surface or skill management | [skills.md](references/settings/skills.md) |
| MCP transport, project inheritance, private bindings, built-in SearXNG/Playwright, enable/disable or connection checks | [mcp.md](references/settings/mcp.md) |
| Plugin/marketplace install, ownership, activation, private setup or recovery | [plugins.md](references/settings/plugins.md) |
| Hook events, actions, payloads and actual-event verification | [hooks.md](references/settings/hooks.md) |
| Wiki switches, import/organization limits, evidence and failed-job recovery | [wiki.md](references/settings/wiki.md) |
| Self-evolution, learned overlays, proposals, canary/rollback or ratings | [evolution.md](references/settings/evolution.md) |
| Channel task budgets, peer communication policy, Goal-Pro or project-guide initialization | [runtime.md](references/settings/runtime.md) |
| Studio targets/accounts, activation, failed-turn continuation, templates or client preferences | [studio.md](references/settings/studio.md) |
| KCoder TUI copy/F9, theme, outline/F8, context indicator or navigation | [tui.md](references/settings/tui.md) |
| Training isolation and background-model/memory effects | [training.md](references/settings/training.md) |

A configured capability does not imply the current tool is registered, authorized or working. Check the actual current catalog before recommending a tool invocation. Never enable a feature merely to obtain a missing tool.

## Configuration scope and minimal writes

`KCODER_CONFIG_DIR` overrides `KCODER_HOME`; without either, a regular user profile uses `~/.config/kcoder`. Current Windows Desktop resolves the account's Known Folder, uses `.config\kcoder` by default and no longer selects an AppData replacement based on Home ACL observations or an old recovery preference. Older installed builds may differ: inspect the running target, not a source change. An inaccessible path remains an access error; do not change ownership, weaken permissions or relocate data as a workaround.

Ordinary settings merge from built-in defaults, user, executable-directory, project `.kcoder/settings.json`, project `.kcoder/settings.local.json`, explicit `--settings-file` overlays in order, then applicable environment/CLI overrides. Some policies have a narrower scope, such as user-only peer communication. Use the actual field's source and contract.

CLI writable scopes are `user`, `project` and `local`. Use the scope the user intended:

```bash
kcoder config set render_markdown true --scope user
kcoder config unset render_markdown --scope project
```

These are examples, not steps to run during every diagnosis. `set` accepts JSON booleans/numbers/arrays/objects or a plain string; `unset` can re-expose a lower layer. Import merges a reviewed JSON/JSONC document, not a replacement profile. Explicit `providers` declarations own the union of declared Provider IDs; each higher-layer `models` table replaces the lower table completely. Preserve sibling models and unrelated settings when changing one entry.

The current target's `settings.schema.jsonc` defines fields and types. User settings support JSONC comments/trailing commas. Do not edit generated schema files or invent settings from names in an error. Settings format v1 (`meta.config_version:1`, also the omitted default) is separate from product versions. Preserve future/unknown-format files, identify their writer and reader builds, and prepare a separately reviewed compatible document instead of changing the version number or silently discarding fields.

`config init` creates missing files; `config migrate` updates user deployment settings. Neither is a read-only check or a general legacy-credential/format converter. Diagnose the specific source/format first. Run either only within the user's requested change, with the correct target and a recoverable backup when needed; do not migrate merely because an old field is present.

## Credentials and verification

Use the selected target's supported private credential form or `kcoder auth`, never public settings, chat, command arguments or shell redirection of a key. `credential_store` selects `auto`, `file` or `keyring`; a credentials file may contain references rather than plaintext. `file` is private-file storage, not guaranteed encryption; forced `keyring` must not silently fall back. See the Provider or MCP guide before moving existing credentials. No configuration operation grants permission to copy identities, pairings or authorization ledgers.

After an authorized write, read back the relevant field/source and distinguish **saved**, **next-turn applied**, **existing-session snapshot** and **actually exercised**. A configuration validation or model list is not a connection/tool test; a successful probe is not complete task acceptance. Honor target capability, revision/CAS and session lifecycle. If the write receipt is lost, reconcile the original operation before retrying; do not force-save, delete a journal or create a fresh ID to replay an unknown effect.
