---
name: kcoder-settings
description: Configure KCoder models, credentials, permissions, Wiki and extensions; diagnose Studio target/account scopes, explicit tool profiles, activation and failed-turn recovery, or KCoder TUI copy, theme and navigation. Not for unrelated terminal troubleshooting or general Markdown writing.
metadata:
  kcoder:
    category: configuration
    tags: [settings, configuration, provider, model, reasoning, studio, remote, wiki, knowledge, retry, permissions, credentials, jsonc, mcp, skills, hooks, plugins, marketplace, tui, clipboard, copy, markdown, theme, outline, navigation]
---

# KCoder Configuration Management

## Goal

Help users safely manage KCoder configuration and extensions, and use and troubleshoot the KCoder TUI. When modifying configuration or authentication, prefer the `kcoder config` and `kcoder auth` commands rather than directly editing configuration files when uncertain.

The `kcoder` in the skill body is a generic command placeholder. When executing, use the current KCoder CLI entry given in the skill activation message; the development profile uses `kcoder-dev` and the formal profile uses `kcoder`. Do not mix the two profiles.

## TUI Operation and Troubleshooting Routing

When the task involves KCoder TUI copy, F9, clipboard, Markdown colors, theme, F8 outline, answer location, or scroll-back review, read [references/tui.md](references/tui.md) first. Distinguish user actions, configuration overrides, terminal capability limits, and program bugs; pure operation instructions do not require modifying or creating configuration first.

## Studio, Remote Targets, and Failed Generation

When Studio settings take effect on the wrong machine, an account/model cannot be selected, an extension needs a new session, a login expires, or a failed response restarts on retry, read [references/studio.md](references/studio.md). Identify the target, KCoder account and server build before proposing configuration changes. A remote target uses its own configuration and credentials; copying its key into Windows local settings is not the default fix. Failed-generation continuation is a runtime capability, not a setting or permission mode to turn on.

## Tool Profiles and Missing Skill Tools

For missing skill discovery/activation or choosing a reduced tool set, read [references/skills.md](references/skills.md#tool-profile-and-missing-discovery-tools). `tools.profile` explicitly selects the tool set; endpoint location and Provider type never select `core`. The default is `full`. Do not change `tui.alternate_screen`, permissions, model reasoning, or model `capabilities.tools` to select a tool profile.

On supporting builds, inspect Studio model details or TUI `/model info` for the
effective output limit and its source. Distinguish next-turn configuration from
an admitted execution's frozen snapshot. Actual registry counts are separate
from model tool capability and tools exposed in a captured request; unknown is
not zero. Workflow Agent and Wiki worker summaries belong to their executions,
not to the current settings file. Wiki workers use no model-callable tools.

Default model output allowances are 262144 tokens (256K), including Wiki stages, summary/session-memory writers and MoA. New Studio model drafts use the same value. Explicit user/provider/model caps and available context still limit actual requests; inherited defaults for a smaller context window are clipped without rewriting an explicit cap. Inspect actual configured/frozen values rather than assuming an upgrade overwrote existing saved limits. No embedding or reranking budget is implied by this output default.

Decoded response memory is bounded independently of those token allowances through optional Provider/model `response_limits`. For `provider_response_limit`, read [references/providers.md](references/providers.md#local-response-memory-limits), inspect the named resource and target's effective limits, and preserve token/context settings. Oversized responses are discarded and their pending tool calls never execute; do not automatically replay them or mistake this local guard for an upstream overload.

Project-guide loading is checked before session/extension initialization: UTF-8 files up to 4 MiB each, 16 MiB total and 128 files. For project_instruction_limit, project_instruction_read or project_instruction_encoding, fix the indicated guide and restart initialization; never run without a partial/missing guide as a workaround. Current-directory AGENTS.md remains authoritative and central-guide symlinks remain supported. Skill reference loading has its own complete-package safeguards; see [references/skills.md](references/skills.md#complete-skill-resource-loading).

## Wiki Availability and Target Scope

Wiki has independent `knowledge.retrieval_enabled` and `knowledge.organization_enabled` boolean overrides. Both default off. When absent, each inherits legacy `knowledge.enabled`; explicit individual values take precedence. Prefer Studio **Wiki → target selector → Retrieval / Organization**. For conversational changes, use Config on the specific key the user requested. A legacy Config write to `knowledge.enabled` sets both; do not use that shorthand when the user requested only retrieval or only organization. Never enable either merely to obtain a missing tool. Neither `tui.alternate_screen`, permissions, nor the Provider address controls these switches.

Retrieval alone mounts `Wiki`; organization alone mounts `WikiManage`, including bounded maintenance reads needed for explicit organization requests. Do not use maintenance reads to bypass disabled retrieval for ordinary question answering. Turning retrieval off does not pause organization. Turning organization off pauses queued/running jobs while retrieval can stay on; re-enabling does not resume those jobs automatically. Eligible running engines refresh each tool independently without restart; restricted registries and `tools.profile: none` remain restricted. Always inspect the actual registry. Neither switch enables implicit conversation ingestion or mandatory retrieval every turn.

The `Wiki` tool supports read actions `libraries`, `pages`, `sources`, `source`, `search`, `read`, `references`, and `citation`. Reuse returned library IDs, revision IDs, and cursors; pin the returned revision when continuing a long page. For explicit maintenance requests, `WikiManage` provides `create`, `set_default`, `rename`, `import_text`, `allocate_ids`, `propose_pages`, `jobs`, and `pause`, plus bounded `find_pages`, `read_page`, `sources`, `source`, and `citation` for explicit maintenance. Import saves evidence; it does not by itself organize pages. Read the original chunks and supply exact citations when proposing generated pages. Reuse idempotency keys only for the same payload. A human-edit conflict does not commit or queue the proposal; direct the user to Studio review/edit instead of inventing a confirmation parameter. Studio supports human edits, history, restore, and review decisions. Its uploads accept up to 10 `.txt`/`.md`/`.html`/`.htm`/`.pdf`/`.docx`/`.xlsx`/`.pptx` documents and PNG/JPEG/WebP images, documents at most 32 MiB, images at most 10 MiB and the batch at most 128 MiB; originals and PDF page references are preserved. HTML import requires knowledgeHtmlV1 on the target, extracts offline text, excludes scripts/hidden content and never fetches external assets. HTML supports BOM UTF-16 and declared encodings such as GBK. Text and Office XML support UTF-8 or BOM-marked UTF-16. Excel reads stored dates/booleans and cached formula results without recalculation. Original images can be previewed and original files downloaded on targets advertising knowledgeOriginalFilesV1. Wiki output is bounded to 1,048,576 tokens, 4 MiB response text and 1 MiB per page; actual requests also honor the selected model output limit and remaining context. Raising Wiki limits cannot raise a model capability limit. If Wiki still truncates, inspect the effective max_tokens and its source, not just providers.<id>.models.<model>.max_output_tokens: an explicit flat max_tokens can override the model limit. Confirm the intended model limit and use the target configuration boundary to remove a stale override (CLI: kcoder config unset max_tokens --scope user), after backing up the target settings; do not silently remove intentional project/CLI overrides or disable reasoning. Citation mismatches receive up to two model repair calls against exact immutable source chunks, subject to the shared three-repair allowance; unresolved quotes still fail. Never normalize fabricated quotes or bypass evidence checks. Automatic Wiki workers may select private host-offered citation refs, which expand exact immutable source spans before evidence validation; this does not change WikiManage public literal citation fields. Do not invent a ref argument for public tools, infer a ref, or treat a valid source span as proof of every surrounding claim. On supporting source builds, `source_support` checks facts and applicable scope separately from quotation repair. It may use one additional model call within that same allowance; it is not an independent guarantee of truth. Automatic new topic summaries have bounded output, while complete existing page updates keep their own allowance within the effective model limit. New automatic workers bind the purpose agenda and full selected-source inventory to the source revision, then verify required unit placements against actual topic-page lines and exact citations. Missing coverage permits one organization_repair complement only if the shared remaining allowance covers both it and the final support call. This does not increase the three-repair limit. Validated intermediate results are reused after resume; do not bypass stale recipe, source, lease or body bindings. Source-only output, unestablished organization coverage, unsupported claims, or uncertainty require review; preserved raw text and a model complete vote are not proof of complete organization. Automatic worker metadata supports host-derived inverse links and explicitly selected whole-page ranges; these are private output forms, not new WikiManage parameters. A correctable owned plan or proof may receive one metadata-only correction within the existing allowance. Foreign source, unit, aspect and citation identities remain errors. Pending review must retain a real private candidate; never suggest editing the database or bypassing validation to make it completed. Dense source paragraphs/table rows and changed page lines may be grouped into complete adjacent ranges to fit the existing review budget; no tail, heading, header or qualifier is discarded. Every constituent assertion still needs support. The entire literal purpose is retained, so formatting/negative constraints are not invented factual topics. Titles, author names, years and versions require supplied-source or retained-citation evidence. A truncated metadata repair must be diagnosed against its actual stage allowance and effective model limit; do not assume raising the global ceiling repairs it. Do not approve review merely to make a job show completed, raise limits to bypass evidence checks, or treat the 1 MiB storage limit as a promise that every model response fits. PDFs need extractable text, with no automatic OCR. Conversational `import_text` is limited to 256 KiB. Studio also previews and imports the selected target folder’s immediate supported files (10 files / 128 MiB; no hidden files or recursive scan). TUI `/wiki` (alias `/knowledge`) reports availability; `/wiki on|off` submits a visible ordinary Config request for both switches, rather than claiming immediate success.

For SSH, inspect the server's configuration and account, not the Windows local profile. The target needs `knowledgeCatalogV1` and, for organization, `knowledgeIngestV1`. Wiki uses its existing model credentials; no embedding or reranking model is required. Shared compatibility-mode profiles share data. Supported Unix SSH/account targets use an independent target-side worker and survive accidental connection loss; managed accounts also need an updated account launcher. Local desktop jobs remain tied to their app-server process and may need resume after restart. Explicit account sign-out pauses jobs before disconnecting; disabling organization and archiving a library also pause work. Re-enabling/restoring does not resume paused jobs automatically. A changed processing recipe can reject resume and should be reported, not bypassed by editing the database. New workers show stage progress and retain validated intermediate results; incomplete JSON is not published. Studio provides archive/restore, source/page search, index rebuild, and legacy `.kwiki` migration up to 64 MiB. New capable targets also transfer streamed collections up to 1 GiB in parts of at most 96 MiB; keep the manifest and every listed part together. Browser download initiation is not proof that all parts were saved. Cancellation or incomplete/corrupt imports preserve the previous library. Migration keeps originals, all page revisions, and human-edit markers; it excludes tasks, identity, and credentials. Import uses the destination target account. Do not invent maintenance actions beyond the actual `WikiManage` schema or treat an imported archive as permission to execute tasks.

## Confirm the Configuration Directory

When reading or modifying configuration, first determine the configuration directory used by the current command:

- `KCODER_CONFIG_DIR`: explicit configuration directory, highest priority.
- `KCODER_HOME`: current user profile root directory.
- When unset, the regular user configuration defaults to `~/.config/kcoder`.

Run first:

```bash
kcoder config path
```

The user's `settings.json` typically lives under the profile, and long-term Provider credentials live in `credentials.json` in the same profile. On startup, the program updates the bundled `settings.schema.jsonc` into that directory for editor validation and completion.

## Configuration Scope and Priority

Configuration is merged roughly in the following order from low to high:

1. Built-in default configuration
2. User configuration: `<profile>/settings.json`
3. Program configuration: `<program-dir>/settings.json`
4. Project configuration: `<project-root>/.kcoder/settings.json`
5. Project local configuration: `<project-root>/.kcoder/settings.local.json`
6. Explicit `--settings-file` overlay
7. Environment variables and CLI arguments

The writable command scopes are `user`, `project`, and `local`. Program configuration is typically provided by the deployment environment; do not mistake it for user configuration.

View the actual source and override relationships:

```bash
kcoder config list --sources
kcoder config get model --source
```

When a value is not taking effect, first confirm which scope it was written into, then check whether it is overridden by a higher-priority project configuration, overlay, environment variable, or CLI argument.

## Common Configuration Operations

View paths, create configuration files, and validate configuration:

```bash
kcoder config path
kcoder config init --scope user
kcoder config init --scope project
kcoder config validate
```

Read, set, and delete dotted keys:

```bash
kcoder config get permission_mode --source
kcoder config set permission_mode auto
kcoder config set permission_mode ask --scope project
kcoder config unset permission_mode --scope project
```

`config set` first attempts to parse the value as JSON; `true`, `false`, numbers, arrays, and objects should use valid JSON, while plain unquoted text is treated as a string. After every modification, the program reloads and validates the merged configuration. Do not continue modifying other scopes when validation fails.

Import JSON or JSONC configuration snippets:

```bash
kcoder config import --file team-settings.jsonc --scope project
```

Check the file contents before importing, and do not put API keys in the imported file. Imports merge into the specified scope and verify the final configuration is valid.

## Extension Management Routing

First determine which layer the user wants to manage, and do not mix different extensions together:

- MCP server: external tool protocol connection; prefer `kcoder mcp`; use `mcp_servers` for complex transports or project configuration.
- Skill: reusable workflows. Use `skill_manage` to write or modify project skills yourself; use `/skills-hub` to install external skills.
- Hook: lifecycle event trigger. There is no standalone hook install command; installation means preparing a script or endpoint and registering it in the `hooks` section of settings.
- Plugin: packages Skill, MCP server, command Hook, and other contributions together and is managed by generation; use `kcoder plugin`, and use `kcoder marketplace` for the source directory.

Project-level MCP, skills, hooks, and plugins are all gated by directory trust. When troubleshooting why project extensions are not loaded, run first:

```bash
kcoder trust status --path /absolute/project
```

Only after the user has explicitly confirmed the directory is trusted, run:

```bash
kcoder trust add --path /absolute/project
```

Do not auto-trust unfamiliar repositories just to make extensions work.

## Adding and Managing MCP Servers

Before handling MCP server addition, transport, scope, credentials, or connection failures, you must read [references/mcp.md](references/mcp.md). That guide covers CLI user-layer limits, project trust, array overrides, HTTP/SSE, secret storage, and new-session verification flow.

## Creating, Installing, and Enabling Skills

Before handling skill creation, external installation, override priority, risk scanning, live reload, or activation failures, you must read [references/skills.md](references/skills.md). That guide distinguishes `skill_manage`, `/learn`, `/skills-hub`, the user layer, and external dirs.

## Installing and Verifying Lifecycle Hooks

Before handling hook installation, event selection, command/prompt/agent/http actions, input/output protocols, or execution failures, you must read [references/hooks.md](references/hooks.md). That guide covers JSONC settings versus strict Hook output JSON, the cleaned command environment, structured effects, cost risks, and real-event verification.

## Installing and Managing Plugins

Before handling plugin/marketplace discovery, installation, compatibility, enable/disable, uninstall, Hook/MCP activation, or managed store failures, you must read [references/plugins.md](references/plugins.md). Do not mistake the `plugin doctor` health status for all declared capabilities being active; rely on compatibility, deferred capabilities, and real Hook/MCP behavior in a new session.

## Training and Benchmark Configuration Isolation

When you need to avoid related memory, session memory, or other extensions contaminating training trajectories, you must read [references/training.md](references/training.md). Do not write `training_mode` into settings; it is a CLI runtime switch and must be paired with a memory-free overlay and a fresh session.

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

## Provider, Model, and Credentials

Before adding multiple models under the same API, switching/removing models, configuring extra request bodies or reasoning, handling the default model, or troubleshooting override relationships, read [references/providers.md](references/providers.md). It contains validatable multi-model examples, per-model body inheritance/clearing, reasoning semantics, full-table overrides, Studio save/apply, and old-version anti-override rules.

Provider configuration and keys must be separated:

- `settings.json` holds the Provider ID, endpoint, protocol, default model, context window, capabilities, and runtime parameters.
- `credentials.json` holds long-term API credentials.
- API keys must not be written into settings, project configuration, JSONC import files, or skill bodies.

Studio's API Key input is a supported way to configure credentials; do not require ordinary users to edit `.env`. Explain that the key is stored in the selected target/account's credential store, not that it is necessarily synchronized to every client or encrypted by every storage backend. Keep key values out of commands, logs and screenshots.

When adding a Provider, first prepare a configuration snippet containing the full endpoint, protocol, default model, and runtime parameters, then import it into the target scope. For authentication:

```bash
kcoder auth login --provider deepseek
kcoder auth status
kcoder --provider deepseek
```

When any explicit settings file declares `providers`, the union of Provider IDs declared by those explicit files owns the complete Provider list; the loader will no longer auto-restore removed built-in profiles. Each Provider's `models` is overridden as a complete model table, not deep-merged across layers one model at a time. If a temporary overlay only wants to change memory, permissions, or timeouts, do not casually copy `providers`. Before deleting or renaming a Provider, check the declared union across user, program, project, local, and all overlays.

Provider IDs are case-sensitive. `providers.<id>` in configuration, `auth login --provider <id>`, and the root keys in `credentials.json` must match exactly. Do not merge multiple Providers into one just because they use the same API protocol.

## Schema and JSONC

- The `settings.schema.jsonc` in the configuration directory is used for editor validation and completion.
- User configuration files can use JSONC comments and trailing commas.
- The root of a configuration file can use `"$schema": "./settings.schema.jsonc"` to point to the local schema for the current profile.
- Do not manually edit the auto-updated `settings.schema.jsonc`; an upgrade or the next startup will replace it with the version shipped with the program.
- Before modifying fields, check the field name, type, enum, and nested structure in the schema; do not add unknown keys from memory.

## Configuration Format Version

The current configuration format is **v1** (`meta.config_version: 1`). This is independent of Studio/CLI release versions, schema filenames and plugin manifest versions. An omitted version is normalized to v1; a future value such as `4` is rejected, not automatically migrated.

For a future-version file, first back up the original bytes securely and identify its writer/build and intended profile. Compare every field and nested structure against the schema shipped with the binary actually reading it. Do not merely change `4` to `1`, delete unknown fields, or assume `config migrate` supports a downgrade. In particular, do not invent support or mappings for `permissions`, `runtime`, `storage`, or unfamiliar `tui` substructures. If compatibility is uncertain, preserve the original and validate a separately prepared, explicitly mapped v1 configuration in an isolated profile; report unsupported fields rather than silently losing them. Do not replace the live profile until the intended settings have a supported representation.

## Migration and Safety Boundaries

When encountering legacy top-level `provider`, `model`, endpoint, or old credential fields, run first:

```bash
kcoder config migrate
```

The migration fills in missing deployment fields and tries to preserve existing values. Keep a configuration backup before migration, especially when handling historical configuration or automated profiles.

Do not use shell redirection to write credentials directly, do not write API keys into settings, do not copy an `.env` from an unverified source into a user profile, and do not use `config unset` to delete fields in a scope you are unsure of. First use `config get <key> --source` to confirm the source, then make the modification and verify the result with `config validate` or `config list --sources`.
