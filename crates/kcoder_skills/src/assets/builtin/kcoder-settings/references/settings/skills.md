# Skill Creation, Installation, and Loading

Read this file only when the task involves writing, installing, overriding, enabling, or troubleshooting skills.

## Directory Layers and Override Priority

Every discovered copy of a name is kept, and exactly one copy is effective. From lowest to highest:

1. Plugin skills (default)
2. Built-in and bundled layer: `<profile>/skills/.builtin/` (`kcoder-settings`, `docx`, `lark-*`, ...)
3. Plugin skills the user explicitly preferred in `skills.source_preference`
4. Project layer: `.kcoder/skills/` discovered by walking up from the cwd (project must be trusted; inner directories override outer ones)
5. External directory: `skills.external_dirs` (later entries override earlier ones)
6. User layer: `<profile>/skills/`

Therefore the actual priority is `user > external > project > preferred plugin > builtin/bundled > plugin`. Between plugins, the smallest plugin ID wins regardless of directory order. A same-name project skill may be silently overridden by a user skill; when troubleshooting, inspect the registry/activation result (Studio's extension inventory lists every copy with `effective`, `shadowedBy` and `shadows`) rather than only checking that the file exists. Runtime expert skills use the separate `expert:` namespace.

Plugin skills are not namespaced, so plugins such as the TRAE/Qoder Feishu `lark` plugins or Anthropic `document-skills` ship names identical to bundled skills; the bundled copy wins until the user opts in:

```jsonc
{ "skills": { "source_preference": {
  "prefer_plugin_skills": { "lark-doc": "lark@trae-cn" }, // one name -> plugin ID (also picks between plugins)
  "prefer_plugins": []                                    // every skill of these plugins beats built-in copies
} } }
```

A per-name entry overrides `prefer_plugins` for that name. Preferences never lift a plugin copy above project, external or user skills. Change them only when the user asks; they apply to new sessions. `skills/setEnabled` disables a whole name (no shadowed copy takes over); `plugins.installed.<id>.skills.enabled=false` removes only that plugin's copies.

`skills.trust_external` controls the trust policy for external sources, but external and user directories are not controlled by the project trust gate's load switch. Do not add unfamiliar download directories directly to `external_dirs`.

## Writing Project Skills

The entry point for a project skill is `.kcoder/skills/<name>/SKILL.md`. The model-side authoring tool is `skill_manage`; it is in the product default `tools.disabled` list (together with `skill_hub` and `skill_curator`). If it is not in the session catalog, tell the user and enable it only on request by removing the exact name from `tools.disabled` in the layer that owns that list, then start a new session. Its actions:

- `list` / `view`: confirm the name, source, and existing content before modifying.
- `patch`: small, localized modifications.
- `edit`: full replacement of SKILL.md.
- `create`: create a new reusable workflow.
- `write_file` / `remove_file`: manage files under `references/`, `scripts/`, `templates/`, or `assets/`.

`list` and `view` return the package's `revision_sha256` (`sha256:<64 hex>`). When modifying an existing Skill, pass that value as
`expected_revision` to `edit`, `patch`, `write_file`, or `remove_file`. A
`conflict` indicates the disk content has changed: re-run `view`, re-evaluate, and do not blindly retry with stale content. Omitting the revision still works for compatibility but returns a deprecation warning and will be removed in a future release.

Use `/learn` to distill workflows from the current conversation; it asks the model to save through `skill_manage`, so it needs that tool enabled. Do not directly modify `.builtin`, do not copy an existing skill under a new name, and do not treat one-off task notes as long-term skills.

A basic SKILL.md must contain valid frontmatter:

```markdown
---
name: example-skill
description: Describes the capability and when to trigger.
---

# Example Skill
```

The name uses lowercase letters, digits, and hyphens. The description should distinguish trigger scenarios; large pattern details go into references, with explicit routing from SKILL.md.

## Installing External Skills

Use `/skills-hub` (alias `/skill-hub`) in the TUI; it runs the hub installer directly as a user command. The default scope is the current project layer (`--project`); for cross-project use, explicitly add
`--user`. Do not simulate a user-level install by modifying the project trust:

```text
/skills-hub install /absolute/path/to/skill
/skills-hub install https://example.com/path/SKILL.md
/skills-hub install github owner/repo skills/example main
/skills-hub install --user github anthropics/skills skills/frontend-design main
```

The corresponding view, search, and uninstall must use the same scope:

```text
/skills-hub list --user
/skills-hub search --user frontend
/skills-hub uninstall --user frontend-design
```

For GitHub sources, prefer passing the skill directory rather than a single `SKILL.md` path. A directory install preserves
`references/`, `templates/`, `scripts/`, `assets/`, and the root
`LICENSE*`, `NOTICE*`, `COPYING*` legal files; a single-file URL can only install that file itself.

The installer first runs `skill_guard` and records provenance. Do not default to adding `--force`, `--trusted`, `--allow-medium-risk`, or `--allow-high-risk`; only after checking the source, SKILL.md, reference files, and scripts, may the corresponding risk be relaxed per the user's explicit authorization.

Uninstall a hub skill with `/skills-hub uninstall <name>`, which archives HubInstalled skills. Self-written skills should be managed via `skill_manage` and must not pretend to be hub skills for uninstall.

User-level skills can also be placed manually in `<profile>/skills/<name>/SKILL.md`, but this bypasses
`skill_guard` and HubInstalled provenance; for external sources, prefer `/skills-hub install --user`.
For team-shared read-only directories, use:

```bash
kcoder config set skills.external_dirs '["/absolute/team-skills"]' --scope user
```

Array overrides follow the ordinary settings layer semantics; check the source before modifying, and do not lose existing directories.

## Studio Selection

Studio **Plugins → Manage → Skills** enables or disables a named Skill for the selected target account across projects. The target profile saves this preference separately from installed content; new conversations use it, while disabling preserves files, plugin ownership, and Skill content already loaded into a conversation.

Use the composer `$` or `/` picker to select a Skill from the current target/account. For the KCoder runtime this is available independently of the model provider; do not diagnose a disabled picker as an inherent vendor limitation. The picker selects Skills, including Skills contributed by plugins, not whole plugins, MCP servers or Hooks. An install/enable update is verified in a genuinely new conversation, without requiring an application restart; already-running work is not promised a replacement Skill snapshot. See [studio.md](studio.md) for target/identity and activation boundaries.

## Activation and Verification

- `skill_manage` and `/skills-hub` return a transaction id, revision, and runtime status on success.
  `committed_reload_pending` means the disk has been committed; you can only retry the registry reload, not reinstall or rewrite.
- A native write also commits the Skill, provenance, and mutation-related usage at the same time; do not manually delete
  `.transactions`, `.commits.jsonl`, or the permanent lock file at the Skill root's sibling.
- `kcoder doctor` only reads and reports pending transactions, orphans, generations, drift, and provenance mismatches across the project, user, and builtin Skill stores; a fresh registry load auto-recovers first and then scans.
- `force` is only for explicitly user-confirmed hub/bundled overrides; ordinary editors, background reviewers, and curators do not
  unconditionally override revisions.
- Manual editors are not enforced by advisory locks. Legitimate external modifications produce a new revision and a drift diagnosis;
  illegal frontmatter or symlinks do not enter the active registry.
- After manually copying user skills or modifying `external_dirs`, start a new session.
- Use `DiscoverSkills` to verify discoverability, then use `skill` to activate and check the actual content.
- A skill declaring `requires_tools` (or `metadata.kcoder.requires_tools`) is hidden and cannot activate while a required tool is missing from the current tool set; a skill cannot restore a disabled tool.
- For headless automation, use `--require-skill <name>` so missing, obscured, untrusted, or unactivatable skills fail before the first model request.
- If the content of a same-name skill is not what you expect, look for the override source in `user > external > project > preferred plugin > builtin/bundled > plugin` order.
- Script-based skills must check script permissions, external commands, network access, and secret reading; activating a skill does not automatically expand task authorization.

## Background Review and Automatic Curator

- `skills.auto_skill_review_enabled` (default `false`) runs a background skill review only while the session is idle: at least `skills.auto_skill_review_idle_minutes` (default `30`, minimum `1`) after the last completed turn, and only when at least `skills.auto_skill_review_interval` (default `10`) new tool calls accumulated since the previous review. At most one review runs per idle period; new input restarts the wait. It needs `skill_manage` in the tool set, makes extra model calls, and is off in training mode. Idle state is in memory, so a session closed before the deadline is not reviewed.
- `skills.auto_curator_enabled` with `auto_curator_interval_hours` and `auto_curator_min_idle_hours` runs the non-LLM curator; its last run is persisted in `.kcoder/skills/.curator-schedule.json`, so restarts keep the schedule, and the first run happens one interval after the store is first seen. It needs `skill_curator` in the tool set.
- Background writes are secret-redacted and scanned by `skill_guard`; medium/high findings are rejected with `status=policy_rejected`. Use the `remember` tool for durable facts; "remember that" in replies is not saved automatically.
- The behaviour above is for `evolution.enabled: false` (the default). With self-evolution on, the review still needs the same switches and `skill_manage` in the tool set, but it no longer writes skills or memory directly: findings about existing skills become evidence, an uncovered workflow becomes a create-skill proposal (`propose`), an `AgentCreated` skill after the write guard (`auto`) or evidence only (`observe`), and `remember` content becomes preference or project-knowledge evidence. Curator merges of learned overlay entries become merge proposals. See [evolution.md](evolution.md#write-ownership).

Before downgrading to an older version that does not understand the Skill journal, first run `kcoder doctor` on the current version to confirm there is no pending transaction or `recovery_required`.

## Tool selection, experts and default-disabled management

Check these independent target-side controls before changing permissions or suggesting a tool call:

| Control | Meaning and activation |
| --- | --- |
| `tools.profile` | Startup registry `full`, `core`, `nano`, `none`; existing engines retain it. |
| `tools.disabled` | Global denylist; wins over an ordinary/expert selection. Product defaults disable management tools including `skill_manage`, `skill_curator`, `skill_hub`, as well as several planning/cron/spec tools. Inspect the actual effective list. |
| `tools.studio.kcoder` / `tools.studio.kworker` | Selected target/account's ordinary Studio-mode choices. Omitted/null follows mode defaults; `[]` selects none. Names are exact, not wildcard patterns. Save affects new conversations, not an existing creation-time snapshot. CLI/TUI do not inherit this Studio-only list. |
| Expert `allowedTools` / `tools.luna.allowed` | An expert's custom list is its tool selection; a null expert list inherits the target Luna list. It does not mean all tools. The ordinary task list is used without an expert. The runtime still applies skill/role/host/global restrictions and unavailable tools stay unavailable. |
| `tools.file_edit_tool` | `edit` (default) or `apply_patch`, pinned for the session. Only that edit surface is exposed/allowed; changing settings does not switch an executing session. Config can inspect it but rejects mid-session writes. |

Use Studio Settings → Tools on the intended target/account for ordinary choices, and the expert's own editor for its list. Do not enable a missing tool by broadening `tools.disabled` to `[]`, changing permission mode, replacing the profile or editing a different target's list. If the user explicitly wants to enable one globally disabled tool, remove only its applicable deny entry at the owning source and keep other restrictions. New selections never register tools, install plugins or grant desktop/external side effects.

When `skill_manage`/`skill_hub` is unavailable, state the actual limitation and use the supported user-invoked management UI/slash entry if available. Do not claim the tool ran, invent an alias or silently enable it just because this guide recommends its workflow. Authorization to edit a skill is not an instruction to enable every maintenance tool.

## Tool Profile and Missing Discovery Tools

Use the target account's settings, not necessarily the Windows client's local profile:

```json
{
  "tools": {
    "profile": "full"
  }
}
```

`tools.profile` accepts `full` (default), `core`, `nano`, and `none`. `full` includes `DiscoverSkills` and `skill`; the reduced `core`/`nano` profiles intentionally do not. `none` mounts neither built-ins nor MCP tools. Existing tool denylists, role restrictions, training mode and model tool capability can still narrow the effective list.

Explicit `--tool-profile full|core|nano|none` overrides the merged setting for that process. Omitted CLI selection and the legacy `--tool-profile auto` follow `tools.profile`; `auto` is not a settings value. Neither private/loopback IP addresses nor the Provider protocol/kind change this choice. An internal reverse proxy can serve a fully capable cloud model.

To inspect/change the persisted value, use the current CLI entry:

```bash
kcoder config get tools.profile
kcoder config set tools.profile full --scope user
kcoder doctor
```

Read the effective profile reported by `doctor`, including any CLI override. The model-facing `Config` tool can describe/read this key but cannot replace a running session's registry. For TUI, start a new process after saving. For Studio, use the tool-profile selector for the current target and create a genuinely new conversation; reopening an already resident conversation does not replace its tool set. Do not promise live mutation of the current conversation.

Diagnose separately: skill installed/discoverable, tool mounted, activation successful. `capabilities.tools=true` enables model tool calls but does not select `full`; `permission_mode=yolo` affects approval, not tool registration; `tui.alternate_screen` only controls terminal rendering. Seeing a skill in Studio's picker alone does not prove the model received `DiscoverSkills`/`skill`. Use the current session tool catalog as evidence. `DiscoverSkills` searches registered skills, not an external marketplace; do not claim the separate `find-skills` skill is bundled.

The model-facing skill candidate catalog contains bounded names and descriptions from the registered skill snapshot, not SKILL.md bodies and not extra callable tools. A skill name is passed to the attached `skill` tool; it is not itself a tool name. The catalog does not grant permission or prove successful activation. Read the activation result before claiming a workflow was loaded. If the catalog reports truncation, use `DiscoverSkills` when attached to find more registered candidates. Trust/guard checks remain in the activation path.

## Studio Mode Tool Selection and Missing Tools

The effective tool set is the intersection of several independent layers. Each layer can only remove tools, never register them.

**Global disable.** `tools.disabled` holds exact names or `prefix*` patterns. Matching tools are neither offered nor callable in CLI/TUI, Studio and every client of the target. The product default list is:

- Worktree: `EnterWorktree`, `ExitWorktree`, `WorktreeCreate`, `WorktreeRemove`
- Cron: `cron_create`, `cron_delete`, `cron_list`
- Spec: all `Spec*` tools
- Plan mode: `EnterPlanMode`, `ExitPlanMode`, `VerifyPlanExecution`
- Skill maintenance: `skill_manage`, `skill_curator`, `skill_hub`
- Other: `AskUserQuestionAsync`, `review`, `CtxInspect`, `LocalMemoryRecall`

An explicit list in a settings layer replaces this default, and an explicit `[]` disables nothing. To enable one tool, remove only that exact name in the layer that owns the list, after the user asks for it.

**`review` runs OpenCodeReview for source-code review.** Never enable it to read images, screenshots or scans:

- Use `read` for images; the model's native vision reads them.
- `read` returns the text layer of PDFs. Pages without one are rendered to PNG with bundled/host `pdftopng` or host `pdftoppm` (at most 5 pages / 12 MiB per call) and returned as images, so a vision-capable model is required. No OCR engine runs.
- `read` also returns text from `.docx`/`.xlsx`/`.pptx` (and `.docm`/`.xlsm`/`.pptm`; macros never run; Excel shows cached formula results). Continue with `offset`/`limit`, not `pages`. Legacy `.doc`/`.xls`/`.ppt` and OpenDocument files must be converted first.

**Studio per-mode selection.** Studio **Settings → Tools** saves `tools.studio.kcoder` and `tools.studio.kworker` in the selected target's user settings. It does not change `tools.profile`, `tools.disabled` or `tools.luna.allowed`.

- A missing key means the mode default. KCoder defaults to every available tool the mode supports. KWorker defaults to the KWorker default list plus registered MCP/plugin tools and eligible desktop tools.
- An explicit `[]` selects no tools. Names are exact, and `*` is not a wildcard there.
- A new Studio conversation keeps a snapshot of its creation-time selection, so editing the defaults does not change existing conversations.

**Default lists.**

- `tools.luna.allowed` defaults to 23 tools: `glob`, `grep`, `read`, `edit`, `write`, `bash` (`PowerShell` on Windows), `TaskOutput`, `TaskStop`, `skill`, `TodoWrite`, `spawn_agent`, `SendMessage`, `wait`, `close_agent`, `WebSearch`, `WebFetch`, `DiscoverSkills`, `explore_agent`, `Workflow`, `REPL`, `AskUserQuestion`, `WebBrowser` and `ContextHistory`.
- The KWorker default list is that Luna list plus:
  - task tools: `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`
  - `Config`, `Sleep`
  - memory: `remember`, `memory_search`, `memory_get`
  - `WorkflowDraft`
  - session tools: `ListSessions`, `ReadSession`, `SendSessionMessage`, `GetSessionMessageReceipt`, `ListSessionMessageReceipts`
  - `bash`/`PowerShell`, `show_widget`, `tool_search` and `tool_execute`
  - `Wiki` and `WikiManage`, which appear only when the user enabled Wiki retrieval or organization.

**Experts.**

- An expert without its own `allowedTools` inherits the default list of the task's mode: KCoder uses `tools.luna.allowed`, and KWorker uses the KWorker default list.
- An explicit expert list is authoritative, and `[]` means no tools.
- Enabled expert skills with a tool restriction narrow the list further.
- Choosing an expert never registers missing tools or grants permissions.

**Why is tool X missing in KWorker (or KCoder)?** Check in this order and report the first layer that removes it:

1. The conversation's mode selection snapshot, or the expert's list.
2. `tools.disabled` on the target.
3. Whether the target registers the tool at all: tool profile, platform shell, Wiki switches, host-provided session tools, a connected MCP server or an enabled plugin.
4. Model tool capability and permission rules.

MCP, plugin and native extension tools are deferred by default in KWorker, KCoder and the CLI/TUI (unless explicitly selected, or `tools.defer_extensions` is `false` outside KWorker). Look for them with `tool_search` and call them through `tool_execute`. They are not missing just because the initial catalog omits them. A zero-match search is not proof of absence. Use the current session's tool catalog as evidence, and create a new conversation after a settings change.

## Node Runtime on Local Studio Targets

For local same-account Studio targets (local transport, no account isolation), the Gateway adds private launchers to the end of the app-server `PATH`, so an installed system Node still wins:

- `node` runs Studio's own executable with `ELECTRON_RUN_AS_NODE=1`.
- `playwright-mcp` (`.cmd` on Windows) runs the bundled Playwright MCP.

The directory of the bundled official Feishu/Lark CLI, `lark-cli` (`lark-cli.exe` on Windows), follows the launchers on `PATH`; a `lark-cli` installed elsewhere on `PATH` still wins. The bundled `lark-*` skills use it. Studio does not store Feishu credentials for it: `lark-cli config init --new` and `lark-cli auth login` keep them in the CLI's own configuration and the OS keychain.

The bundled packages `docx` and `pptxgenjs` are appended to `NODE_PATH`. That affects CommonJS `require` only, not ESM `import`. Pinned packages are pure JavaScript: there are no native modules and no browser download.

Remote SSH/HTTP targets, account-isolated targets and CLI-only installs do not get this runtime. They need their own Node, packages and `lark-cli`. When `require` fails there, install the package on that target as the skill instructs, rather than assuming the Studio host's copy is reachable.


## Complete Skill Resource Loading

The SKILL.md entry supports at most 1 MiB. The immediate references directory loads Markdown files in stable filename order: at most 1 MiB per file, 8 MiB total, 128 Markdown files and 10,000 inspected directory entries. These are filesystem resource safeguards, independent of model token limits. A skill whose frontmatter sets `metadata.kcoder.references: on_demand` is not inlined: the model reads the individual references its body names from the skill base directory (the bundled `lark-*` skills do this). Missing references is valid and creates no directory; ordinary non-Markdown files and nested directories are not imported as prompt text. Symlink resources, unreadable/non-regular Markdown entries, bad UTF-8 or limit violations reject the entire Skill with an error rather than activating incomplete instructions. Preserve user content and fix the specific file, encoding or package; do not force partial activation or widen permissions as a workaround. Legal references retain their text, BOM, CRLF and read-only mode.

The built-in `kcoder-settings` deliberately keeps supporting guides under `references/settings/`, so only its concise SKILL.md is injected by ordinary activation. Read the routed guide explicitly using the returned Skill base directory; loading an unrelated reference is not necessary. Other ordinary skill packages retain their immediate-reference compatibility; expert snapshots already expose reference paths lazily. Package updates are still installed transactionally and resource reads retain the existing file-access and sandbox checks.
