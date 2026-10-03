# Skill Creation, Installation, and Loading

Read this file only when the task involves writing, installing, overriding, enabling, or troubleshooting skills.

## Directory Layers and Override Priority

The Skill registry loads in the following order, with same-name entries overridden by the later-loaded layer:

1. Built-in layer: `<profile>/skills/.builtin/`
2. Project layer: `.kcoder/skills/` discovered by walking up from the cwd (project must be trusted)
3. External directory: `skills.external_dirs`
4. User layer: `<profile>/skills/`

Therefore the actual priority is `user > external > project > builtin`. A same-name project skill may be silently overridden by a user skill; when troubleshooting, you must inspect the registry/activation result rather than only checking that the project file exists.

`skills.trust_external` controls the trust policy for external sources, but external and user directories are not controlled by the project trust gate's load switch. Do not add unfamiliar download directories directly to `external_dirs`.

## Writing Project Skills

The entry point for a project skill is `.kcoder/skills/<name>/SKILL.md`. In an Agent session, use `skill_manage`:

- `list` / `view`: confirm the name, source, and existing content before modifying.
- `patch`: small, localized modifications.
- `edit`: full replacement of SKILL.md.
- `create`: create a new reusable workflow.
- `write_file`: write into `references/`, `scripts/`, `templates/`, or `assets/`.

`list` and `view` return the package's `revision_sha256`. When modifying an existing Skill, you should pass that value as
`expected_revision` to `edit`, `patch`, `write_file`, or `remove_file`. A
`conflict` indicates the disk content has changed: re-run `view`, re-evaluate, and do not blindly retry with stale content. The
revision-omitting compatibility behavior is retained for only one release cycle and returns a deprecation warning.

Use `/learn` to distill workflows from the current conversation. Do not directly modify `.builtin`, do not copy an existing skill under a new name, and do not treat one-off task notes as long-term skills.

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

Use `/skills-hub` in the TUI. The default install is to the current project layer; for cross-project use, explicitly add
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

The installer first runs `skill_guard` and records provenance. Do not default to adding `--force`, `--allow-medium-risk`, or `--allow-high-risk`; only after checking the source, SKILL.md, reference files, and scripts, may the corresponding risk be relaxed per the user's explicit authorization.

Uninstall a hub skill with `/skills-hub uninstall <name>`, which archives HubInstalled skills. Self-written skills should be managed via `skill_manage` and must not pretend to be hub skills for uninstall.

User-level skills can also be placed manually in `<profile>/skills/<name>/SKILL.md`, but this bypasses
`skill_guard` and HubInstalled provenance; for external sources, prefer `/skills-hub install --user`.
For team-shared read-only directories, use:

```bash
kcoder config set skills.external_dirs '["/absolute/team-skills"]' --scope user
```

Array overrides follow the ordinary settings layer semantics; check the source before modifying, and do not lose existing directories.

## Studio Selection

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
- For headless automation, use `--require-skill <name>` so missing, obscured, untrusted, or unactivatable skills fail before the first model request.
- If the content of a same-name skill is not what you expect, look for the override source in `user > external > project > builtin` order.
- Script-based skills must check script permissions, external commands, network access, and secret reading; activating a skill does not automatically expand task authorization.

Before downgrading to an older version that does not understand the Skill journal, first run `kcoder doctor` on the current version to confirm there is no pending transaction or `recovery_required`.

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
