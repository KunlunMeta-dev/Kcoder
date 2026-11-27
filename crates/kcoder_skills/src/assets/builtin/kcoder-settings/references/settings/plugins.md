# Plugin and Marketplace Management

Read this file only when the task involves discovering, installing, enabling/disabling, uninstalling, or troubleshooting plugin/marketplace. User guide: `docs/plugins.md`.

## Capability and Compatibility Boundaries

KCoder reads the native `.kcoder-plugin/plugin.json` (root `plugin.json`/`kcoder-plugin.json` remain legacy native forms), Agent Plugins v1 (root `plugin.json` with the fixed 1.0.0 `$schema`; validated locally, never downloaded), and vendor manifests `.codex-plugin`, `.claude-plugin`, `.cursor-plugin`, `.trae-plugin`, `.qoder-plugin`, `.codebuddy-plugin`, and `.grok-plugin` (each `<dir>/plugin.json`). When a vendor manifest omits a contribution, convention discovery uses `skills/` (or a root `SKILL.md`), `commands/`, `agents/`, `hooks/hooks.json`, and `.mcp.json`/`mcp.json`.

The runtime activates Skills, MCP servers, `command`-type Hooks, and supported Markdown command/Agent profiles. Other plugin Hook action types are parsed but not activated (`unsupported_hook_action`). Adapted command/Agent profiles appear as namespaced plugin skills and delegate real child tasks through spawn_agent. Apps/connectors, LSP servers, output styles and other host-only features remain deferred. Plugin skills are not namespaced: a plugin skill with the same name as a built-in/bundled skill (for example the Feishu `lark` plugins' `lark-*`) is shadowed by the built-in copy unless the user opts in through `skills.source_preference` (see skills.md). Host-managed plugin `binaries` and plugin `bin/` directories are not put on `PATH`; plugin skills use whatever `lark-cli` the target `PATH` resolves.

Compatibility levels are `fully_supported`, `partially_supported` (at least one capability deferred), `metadata_only`, `incompatible`, and `invalid`. `plugin doctor`'s `healthy: true` only means there are no load diagnostics and no `invalid`/`incompatible` plugin in scope; it does not mean all capabilities are activated, nor that an external process can start.

A plugin ID is the stable `<name>@<marketplace>` (exactly one `@`). Local directory installs use `@local`; built-in offline bundles use `@kcoder-bundled`. Read, doctor, enable, disable, and uninstall all take the full ID; do not guess from the name.

## Audit First, Then Install

A Plugin is an executable extension: Hooks can run commands in lifecycle events and affect tool input, stdio MCP spawns local processes, and HTTP/SSE MCP connects to network services. Before installing, at minimum check:

- Repository and license, pinned commit/SHA or npm integrity.
- manifest, Hook JSON, all scripts called by Hooks, MCP command/args, package scripts, and dependencies.
- File write scope, network access, subprocesses, credential reading, and whether code is dynamically downloaded.
- Hook's project root judgment. Test in an isolated project root with clear markers such as `.git` or `package.json` so the plugin does not walk up and scan overly large parent directories.

Do not auto-trust plugin source code just because the marketplace can list the plugin. If auditing is not yet complete after installing an unfamiliar plugin, disable it first, and do not start a new session.

## Studio Marketplace Selection

Use Studio → Plugins → marketplace dropdown to select a complete catalog, then browse/search and install a specific plugin. Presets: Claude, OpenAI, xAI/Grok, Tencent CodeBuddy, WorkBuddy official and Teams, ByteDance TRAE Code / Work (China), Alibaba Qoder, Anthropic Skills and Superpowers. Selecting a marketplace fetches its catalog on the current execution target; it does not install all entries. A single-product repository (such as OpenViking or EdgeOne) must not be presented as the vendor's entire marketplace. Kimi Work is excluded because its catalog requires additional authorization; do not initiate marketplace account authorization or substitute Kimi Code for it.

Hosted (non-Git) catalogs are Qoder (`https://qoder.com/marketplace`), TRAE (public `trae-remote-official` registry at `https://api.trae.com.cn/extensions/api/-/plugin/list`) and WorkBuddy (CDN ZIP catalogs). Qoder packages are checked against the published SHA-256 and TRAE packages against the published size and SHA-256 before extraction; WorkBuddy's CDN publishes no digest, so KCoder records the observed archive SHA-256 as provenance, not a publisher signature. Arbitrary hosted marketplace APIs are not interchangeable with Git sources. Older servers without `hostedPluginMarketplacesV1` (plus `traeCnPluginMarketplaceV1`/`workbuddyPluginMarketplaceV1` for those catalogs) must be upgraded before registering them. Registration, refresh, installation and uninstall use the same target-owned managed store; a ZIP integrity/path failure leaves the previous installed copy intact. Hosted packages may contain several client manifests: KCoder keeps the marketplace-selected adapter instead of choosing another vendor's manifest by order.

A catalog listing or successful package install does not establish that every service works: retain incompatibility diagnostics, complete required credentials and dependencies, and distinguish package installation from a real service call. Public catalog access does not authorize a plugin's external service; private or host-only entries are not implied by public catalog support. Do not substitute a third-party mirror or a single plugin for an official catalog.

## Plugin Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `plugins.runtime.enabled` | `true` | `false` stops activating managed and directly discovered plugins; management lists keep safe metadata |
| `plugins.runtime.project_policy` | `trusted_only` | `disabled` skips project `.kcoder/plugins/` and project-scoped installs even when trusted |
| `plugins.compatibility.<format>` | `true` | Per-format toggles: `agent_plugins_v1`, `codex`, `claude`, `cursor`, `grok`, `codebuddy`, `qoder`, `trae` |
| `plugins.installation.allow_local` / `allow_git` / `allow_http` / `allow_npm` | `true` | Source-kind gates; `allow_http` covers hosted catalog/package downloads |
| `plugins.installation.require_git_sha` | `false` | Require a pinned Git commit |
| `plugins.installation.require_npm_integrity` | `true` | Require registry SHA-512 integrity |
| `plugins.installation.max_files` / `max_total_bytes` / `max_file_bytes` / `timeout_ms` | `10000` / 256 MiB / 32 MiB / `120000` | Install copy/download bounds |
| `plugins.installation.proxy_url`, `auto_detect_proxy`, `proxy_scan_ports` | unset / `false` / `[]` | Target download proxy; see below |
| `plugins.installed.<id>.enabled` | manifest default | Written to user settings by enable/disable; `skills.enabled`, `hooks.enabled`, `mcp_servers.<name>.{enabled,enabled_tools,disabled_tools}` narrow contributions |

Studio's per-plugin "Enable this plugin's skills" switch writes only `plugins.installed.<id>.skills.enabled` (`false` to turn off; removed to restore the default) through `plugin/skills/setEnabled`; it removes only that plugin's skill copies, keeps the plugin, its MCP servers and Hooks enabled, and applies to new conversations.

A higher-priority project/local layer can override the user-layer `plugins.installed` entry the CLI writes; check `kcoder config get plugins.installed --source` when an enable/disable seems ineffective.

## Local Directory Install and Status Check

Local directories are copied to a private managed store and do not run directly from the original directory:

```bash
kcoder plugin install --path /absolute/path/to/plugin
kcoder plugin list --all --json
kcoder plugin read plugin-name@local --json
kcoder plugin doctor plugin-name@local --json
```

`plugin list` without `--all` hides disabled plugins. Focus on `source`, `version`, `root`, `file_count`, `compatibility.supported_capabilities`, `compatibility.deferred_capabilities`, `compatibility.issues`, `mcp_server_names`, `hook_event_names`, `hook_matcher_count`, and diagnostics. The `root` in the output is the actual running copy. In the TUI, `/plugins` lists the same discovery result.

## Local Marketplace

The CLI registers only local marketplaces (Studio can also add Git and hosted URLs). `--path` is a marketplace root or manifest file; supported layouts are `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, and `marketplace.json` under `.claude-plugin`, `.cursor-plugin`, `.grok-plugin` or `.codebuddy-plugin`. The marketplace ID must equal the manifest `name`. Entries can point to local, Git, npm, or built-in bundle sources:

```bash
kcoder marketplace add team-tools --path /absolute/path/to/marketplace
kcoder marketplace list --json
kcoder marketplace refresh team-tools --json
kcoder plugin install --marketplace team-tools --name issue-triage
kcoder plugin read issue-triage@team-tools --json
```

`marketplace refresh` re-reads catalogs (only managed Git/hosted snapshots are re-downloaded) and does not upgrade already installed copies. Removing a registration only deletes its user-settings entry; it does not uninstall plugins installed from it:

```bash
kcoder marketplace remove team-tools
```

In an explicitly configured local marketplace, Git sources accept credential-free HTTPS (no query/fragment), `file://`, or absolute local paths. Downloaded (managed) marketplace snapshots are confined: their Git sources must be HTTPS and they cannot reference local paths outside the snapshot. Pin the full SHA. npm downloads run with lifecycle scripts disabled and verify the registry's SHA-512 integrity; this does not replace source auditing.

## Enable/Disable, Uninstall, and Session Snapshot

```bash
kcoder plugin disable plugin-name@marketplace
kcoder plugin enable plugin-name@marketplace
kcoder plugin uninstall plugin-name@marketplace
kcoder plugin uninstall plugin-name@marketplace --purge-data
```

Enable/disable applies to managed (installed) plugins only. Each Engine freezes a plugin generation at creation. Create a new session after install, enable, disable, or uninstall; old sessions do not hot-load new Skill/MCP/Hook, nor do they unload already frozen snapshots. Uninstall retains plugin data by default; only use `--purge-data` when the user explicitly requests data clearing.

The managed store is `<profile>/plugin_store/`: `state.json` holds atomic state, `cache/` holds running copies, `data/` holds plugin data (`data/<marketplace>/<plugin>`, kept across updates), `marketplaces/` holds downloaded catalog snapshots, and `locks/`, `staging/`, `backups/`, `transactions/` serve transactions and recovery. Opening the store recovers interrupted transactions automatically. Do not manually edit `state.json` or delete cache; use the CLI, and use `plugin doctor` to find missing managed copies (`managed_plugin_missing`) and other diagnostics.

## Hook and MCP Real Verification

Plugin command Hooks receive `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `GROK_PLUGIN_ROOT`, `CODEBUDDY_PLUGIN_ROOT`, `QODER_PLUGIN_ROOT`, `TRAE_PLUGIN_ROOT`, and `PLUGIN_ROOT`, all pointing to the actual plugin copy; vendor-format MCP servers get the same variables and their `${…}` placeholders. Agent Plugins v1 `mcp.json` expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in args, env values and `cwd` (not command, URL or headers). Plugin MCP servers are named `plugin.<plugin-id>.<server>`. If a script still cannot find its files, use `plugin read` to confirm the actual `root`, then check file permissions and whether the interpreter exists.

Verification sequence:

1. `kcoder plugin doctor <id> --json`, confirming there are no parsing or managed diagnostics for contributions.
2. Create a new session to let the startup Hook and plugin MCP assemble from the new generation.
3. Use `/hooks` to check the event, matcher, source, and action, and trigger a non-destructive real event; seeing only a matcher does not mean the script executed successfully.
4. Use `/mcp verbose` to check namespaced servers, transport, connection errors, and tool count, then call one read-only tool.
5. If there are deferred capabilities, explicitly record the unverified parts; do not substitute other capabilities' success for them.

Hook matchers and scripts may use another host's tool names. For tool events KCoder only adds lowercase aliases for `Skill`, `Write` and `Edit` in plain `|` matcher lists. If the matcher is loaded but the target event has no effect, compare the query in `/hooks`, the `tool_name` read by the script, and the actual KCoder tool name; do not only check JSON syntax.

## Project Plugins and Trust

Project `.kcoder/plugins/` directories (in the working directory and its ancestors) and project marketplaces are gated by folder trust of their owning directory. Check first:

```bash
kcoder trust status --path /absolute/project
```

Only after the user explicitly approves the directory, run `kcoder trust add --path /absolute/project`. The target user's home directory and its descendants are trusted by default; `kcoder trust never --path …` takes precedence, and `trust revoke` also removes the inherited home default. When several directly discovered roots provide the same plugin ID, all of them are skipped with `duplicate_plugin_id`. User-level managed plugins are not invalidated because the current project is untrusted, but the plugin's own Hook/MCP can still touch the current working directory; this is why the execution boundary must be audited before installation.

## Studio Trust and Download Environment

In Studio Plugins, use the trust-management entry to browse/select a directory and manage its grant, revoke or explicit never-trust decision. The add-marketplace dialog also provides directory selection and an explicit trust choice. Selecting a path alone does not grant trust. For a remote target, both the chosen path and trust store belong to that target/account, not Windows. Do not ask users to trust a managed cache's temporary hash directory to repair a download.

The optional download proxy is saved per execution target; its `127.0.0.1` means that target. CA files likewise must exist on the installation target and be available to its process environment. The cleaned Git child environment carries trusted CA inputs (`GIT_SSL_CAINFO`/`GIT_SSL_CAPATH`/`GIT_PROXY_SSL_CAINFO`, with `SSL_CERT_FILE`/`SSL_CERT_DIR` or `CURL_CA_BUNDLE` fallbacks); npm carries `npm_config_cafile` and `NODE_EXTRA_CA_CERTS` where configured and always keeps `strict-ssl`. These are process environment inputs, not settings fields or a Studio CA-file editor. Git for Windows honors an explicitly supplied CA with Schannel. Do not repair certificate failures by disabling TLS verification. Distinguish connection reset, proxy, certificate, missing repository and authorization errors instead of repeatedly cloning blindly.

Hosted HTTPS downloads require `curl` on the execution target (included with current Windows versions). They share the target download proxy, honor `CURL_CA_BUNDLE`/`SSL_CERT_FILE`, do not follow redirects, enforce byte/time limits, and verify digests before extracting as described above. An SSH target downloads and installs on the server, not on the Windows client.

## Automatic Proxy Detection

Use the Plugins page automatic local proxy switch to set `plugins.installation.auto_detect_proxy` (default `false`). Detection belongs to the selected execution target (localhost on SSH means the server) and does not scan other LAN hosts or alter the system proxy. Without `proxy_scan_ports` it enumerates all current-target TCP listeners and their bound local addresses, with no hardcoded port list; the optional `proxy_scan_ports` (at most 256 nonzero ports) restricts the candidates instead. Bounded parallel HTTP CONNECT/SOCKS5 protocol probes precede ordered real HTTPS checks, stopping at the first working proxy; an open port or CONNECT reply is not sufficient.

Manual `proxy_url` is preserved when the switch is off. When the switch is on, a manual/environment proxy is only used after it also passes HTTPS validation; if nothing verifies, the download fails with a rescan hint instead of silently using an unverified proxy. A stale saved localhost port is not evidence of a working proxy: check the target's actual listener and protocol (HTTP versus SOCKS5). Timeout/scan-limit results mean detection was incomplete, not that all proxies failed. Verified proxy results are cached per target/profile and HTTPS origin for a short finite lifetime and checked again afterwards. Qoder/TRAE CDN icons use the same target download proxy and bounded image data; browser proxy configuration is not required for them. Re-scan after changing proxies to retry failed artwork. Do not disable TLS validation to bypass detection failure.

For installation failures, inspect the specific plugin card's failure details. A metadata-only plugin whose definitions/features remain deferred cannot become usable by re-downloading it; explain the reported missing adapter. Do not classify all commands/agents as unsupported, and do not equate successful marketplace registration with support for every entry.

## Adapted Markdown Commands and Agents

After installing/enabling a supported prompt plugin, create a new conversation. Use the exact namespaced entry from the skill catalog (or Studio's plugin trial entry; Studio's composer `$`/`@` menus only insert the reference into the draft); load it with Skill, then follow its launcher: spawn_agent with `plugin_agent` equal to that exact registered name and `message` containing the task/arguments. TUI and Studio use the same registry and child runner. This is an adapter through the skill entry, not an alias for every vendor's original slash command syntax.

The delegated task uses the active provider/model; vendor model aliases are not silently resolved to another account. Agent `tools` lists restrict the child; `allowed-tools` pre-approvals do not grant extra permissions and normal parent policy still applies. Declared `maxTurns` (1–100) caps and tool restrictions survive follow-up. Plugin instruction paths are distinct from the task working directory; follow the task workspace for user files.

Supported argument forms include full `$ARGUMENTS`, zero-based `$0`/`$ARGUMENTS[0]`, and named arguments declared in frontmatter. Quoted arguments remain a single value; supplied argument text is not recursively re-expanded. Plugin-root aliases and invoking-session, skill-directory and project-directory variables are resolved without executing shell text. Inline shell injection, per-agent hooks/permission overrides/memory modes and unsupported host variables are rejected with diagnostics. No command is executed merely by catalog discovery or installation. Inspect compatibility issues when a plugin has a supported subset.

## Private Setup, Revalidation, and Actual Runtime Facts

For missing credentials, prefer Studio's plugin-detail private form after confirming the exact catalog source or immutable installed operation/generation. Only currently missing declared names may be supplied; concurrent submissions cannot overwrite an existing value. Values stay in the selected execution target's existing private credential store, including SSH target profiles, never chat, public settings or a fake Provider ID. An unavailable OS marker is an error, not permission to replace an unknown key. `kcoder auth migrate --to keyring|file` preserves the plugin namespace but currently migrates Provider keys only.

On supported targets, existing same-operation plugin credentials refresh on the next ordinary user turn. A retry/continuation and already-running/forked agent retain their frozen snapshot. Refresh only the affected MCP servers; do not restart all work. Installing/enabling new packages still requires the supported new-snapshot/session activation path. Private plugin configs and values are not model-facing Config output; headers, tool metadata/results and diagnostics must not reveal them.

Select an existing conversation to inspect real skill discovery, Hook execution and MCP connection/tool-registration facts. Configuration-only/bootstrap data cannot prove a component usable. Missing observations remain unknown; a callback or parsed declaration is not authorization/operation success. A temporary network failure can use one-hour exact-source revalidation through a scratch download; it neither installs the package nor executes Hooks. Hash/publisher/platform/unsupported restrictions remain blocking.
