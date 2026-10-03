# Plugin and Marketplace Management

Read this file only when the task involves discovering, installing, enabling/disabling, uninstalling, or troubleshooting plugin/marketplace.

## Capability and Compatibility Boundaries

KCoder can read native manifests, as well as Agent Plugins v1, `.codex-plugin`, `.claude-plugin`, `.cursor-plugin`, `.grok-plugin`, `.codebuddy-plugin`, and `.qoder-plugin`. When an external manifest does not explicitly declare contributions, it also follows the convention to discover `skills/`, `hooks/hooks.json`, `.mcp.json`/`mcp.json`, and `commands/`.

The runtime activates Skills, MCP servers, command Hooks, and supported Markdown command/Agent profiles. Adapted command/Agent profiles appear as namespaced plugin skills and delegate real child tasks through spawn_agent. Apps/connectors and unsupported host-only features remain deferred. The Qoder hosted catalog is supported through its public HTTP directory and SHA-256-verified ZIP packages; arbitrary hosted marketplace APIs are not interchangeable with Git sources. `fully_supported` means all declared capabilities of the plugin are supported; `partially_supported` means at least one capability is deferred. `plugin doctor`'s `healthy: true` only indicates that the manifest, contributions, and managed state are consistent; it does not mean all capabilities are activated, nor that the external process can be started.

A plugin ID is the stable `<name>@<marketplace>`. Local directory installs use `@local`; built-in offline bundles use `@kcoder-bundled`; subsequent read, doctor, enable, disable, and uninstall all pass the full ID, do not just guess the name.

## Audit First, Then Install

A Plugin is an executable extension: Hooks can run commands in lifecycle events and affect tool input, stdio MCP will spawn local processes, and HTTP/SSE MCP will connect to network services. Before installing, at minimum check:

- Repository and license, pinned commit/SHA or npm integrity.
- manifest, Hook JSON, all scripts called by Hooks, MCP command/args, package scripts, and dependencies.
- File write scope, network access, subprocesses, credential reading, and whether code is dynamically downloaded.
- Hook's project root judgment. Should be tested in an isolated project root with clear markers such as `.git` or `package.json` to avoid the plugin scanning overly large parent directories by walking up on its own.

Do not auto-trust plugin source code just because the marketplace can list the plugin. If auditing is not yet complete after installing an unfamiliar plugin, disable it first, and do not start a new session.

## Studio Marketplace Selection

Use Studio → Plugins → marketplace dropdown to select a complete catalog, then browse/search and install a specific plugin. Presets include Claude, OpenAI, xAI/Grok, Tencent CodeBuddy, WorkBuddy official and Teams, TRAE Code / Work China, Anthropic Skills, Superpowers and Alibaba Qoder. Selecting a marketplace fetches its catalog on the current execution target; it does not install all entries. A single-product repository (such as OpenViking or EdgeOne) must not be presented as the vendor's entire marketplace.

Qoder uses `https://qoder.com/marketplace`; registration, refresh, installation and uninstall use the same target-owned managed store. `plugins.installation.allow_http` controls hosted catalog/package downloads; `allow_git` controls Git sources independently. ZIP integrity/path failures leave the previous installed copy intact. Root manifest formats can be disabled independently with `plugins.compatibility.grok`, `.codebuddy`, `.qoder`, and `.trae`. Older servers without `hostedPluginMarketplacesV1` must be upgraded before registering Qoder.

A catalog listing or successful package install does not establish that every service works: retain incompatibility diagnostics, complete required credentials and dependencies, and distinguish package installation from a real service call. TRAE uses the public `trae-remote-official` registry at `https://api.trae.com.cn/extensions/api/-/plugin/list`; private or host-only entries are not implied by public catalog support. Do not substitute a third-party mirror or a single plugin for an official catalog.

## Local Directory Install and Status Check

Local directories are copied to a private managed store and do not run directly from the original directory:

```bash
kcoder plugin install --path /absolute/path/to/plugin
kcoder plugin list --all --json
kcoder plugin read plugin-name@local --json
kcoder plugin doctor plugin-name@local --json
```

Focus on checking `source`, `version`, `root`, `file_count`, `compatibility.supported_capabilities`, `deferred_capabilities`, `issues`, `hook_matcher_count`, and diagnostics. The `root` in the output is the actual running copy.

## Local Marketplace

KCoder currently registers a local marketplace root directory; entries in it can point to local, Git, npm, or built-in bundle sources:

```bash
kcoder marketplace add team-tools --path /absolute/path/to/marketplace
kcoder marketplace list --json
kcoder marketplace refresh team-tools --json
kcoder plugin install --marketplace team-tools --name issue-triage
kcoder plugin read issue-triage@team-tools --json
```

`marketplace refresh` re-resolves sources and does not automatically upgrade already installed copies. Deleting a registration only removes the marketplace configuration, not the uninstallation of plugins installed from it:

```bash
kcoder marketplace remove team-tools
```

Git sources only accept HTTPS, `file://`, or absolute local fixture paths; the full SHA should be pinned. npm downloads disable lifecycle scripts and validate the SHA-512 integrity returned by the registry; this does not replace source auditing.

## Enable/Disable, Uninstall, and Session Snapshot

```bash
kcoder plugin disable plugin-name@marketplace
kcoder plugin enable plugin-name@marketplace
kcoder plugin uninstall plugin-name@marketplace
kcoder plugin uninstall plugin-name@marketplace --purge-data
```

Each Engine freezes a plugin generation once at creation. A new session must be created after install, enable, disable, or uninstall; old sessions do not hot-load new Skill/MCP/Hook, nor do they uninstall already frozen snapshots. Uninstall by default retains plugin data; only use `--purge-data` when the user explicitly requests data clearing.

The managed store defaults to `<profile>/plugin_store/`, where `state.json` holds atomic state, `cache/` holds running copies, and `staging/`, `backups/`, and `transactions/` are used for transactions and recovery. Do not manually edit `state.json` or directly delete cache; prefer using the CLI, and use `plugin doctor` to check for residual transactions and missing directories.

## Hook and MCP Real Verification

External command Hooks and MCP receive `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `GROK_PLUGIN_ROOT`, `CODEBUDDY_PLUGIN_ROOT`, `QODER_PLUGIN_ROOT`, `TRAE_PLUGIN_ROOT`, and `PLUGIN_ROOT`, all pointing to the actual plugin copy. The corresponding `${…}` placeholders in MCP configuration expand to that directory; if the script still cannot find it, first use `plugin read` to confirm the actual `root`, then check file permissions and whether the interpreter exists.

Verification sequence:

1. `kcoder plugin doctor <id> --json`, confirming there are no parsing or managed diagnostics for contributions.
2. Create a new session to let the startup Hook and plugin MCP assemble from the new generation.
3. Use `/hooks` to check the event, matcher, source, and action, and trigger a non-destructive real event; seeing only a matcher does not mean the script executed successfully.
4. Use `/mcp verbose` to check namespaced servers, transport, connection errors, and tool count, then call one read-only tool.
5. If there are deferred capabilities, explicitly record the unverified parts; do not substitute other capabilities' success for them.

Hook matchers and Hook scripts may also use the tool name conventions of another host. If the matcher is loaded but the target event has no effect, compare the query in `/hooks`, the `tool_name` read by the script, and the actual KCoder tool name; do not only check JSON syntax.

## Project Plugins and Trust

Project `.kcoder/plugins/` and project marketplaces are gated by folder trust. Check first:

```bash
kcoder trust status --path /absolute/project
```

Only after the user explicitly approves the directory, run `kcoder trust add`. User-level managed plugins are not automatically invalidated because the current project is untrusted, but the plugin's own Hook/MCP can still touch the current working directory; this is exactly why the execution boundary must be audited before installation.


## Studio Trust and Download Environment

In Studio Plugins, use the trust-management entry to browse/select a directory and manage its grant, revoke or explicit never-trust decision. The add-marketplace dialog also provides directory selection and an explicit trust choice. Selecting a path alone does not grant trust. The target user's home directory is trusted by default; an explicit never-trust decision takes precedence. For a remote target, both the chosen path and trust store belong to that target/account, not Windows. Do not ask users to trust a managed cache's temporary hash directory to repair a download.

The optional download proxy is saved per execution target; its `127.0.0.1` means that target. CA files likewise must exist on the installation target and be available to its process environment. The cleaned Git child environment explicitly carries trusted CA inputs (`GIT_SSL_CAINFO`/`GIT_SSL_CAPATH`, with `SSL_CERT_FILE`/`SSL_CERT_DIR` or `CURL_CA_BUNDLE` fallbacks); npm carries `npm_config_cafile` and `NODE_EXTRA_CA_CERTS` where configured. These are process environment inputs, not new arbitrary settings fields or a Studio CA-file editor. Git for Windows honors an explicitly supplied CA with Schannel. Do not repair certificate failures by disabling TLS verification. Distinguish connection reset, proxy, certificate, missing repository and authorization errors instead of repeatedly cloning blindly.

Hosted HTTPS downloads require `curl` on the execution target (included with current Windows versions). They share the target download proxy, honor `CURL_CA_BUNDLE`/`SSL_CERT_FILE`, do not follow package redirects, enforce byte/time limits, and verify Qoder's published SHA-256 before extracting. An SSH target downloads and installs on the server, not on the Windows client.


## Public Catalogs and Automatic Proxy Detection

Studio's marketplace selector includes TRAE Code / Work China and WorkBuddy official
and Teams catalogs alongside Claude, OpenAI, xAI, CodeBuddy and Qoder. Kimi Work is
excluded because its catalog requires additional authorization. Do not initiate extra
marketplace account authorization or substitute Kimi Code for Kimi Work. Public catalog
access does not authorize a plugin's external service; report that limitation explicitly.

Use the Plugins page automatic local proxy switch to set
`plugins.installation.auto_detect_proxy` (default false). Detection checks candidate
ports one by one with real HTTPS validation and stops at the first working proxy;
an open port is not sufficient. Optional `plugins.installation.proxy_scan_ports` is an
advanced list of up to 256 distinct positive ports. Detection belongs to the selected
execution target, so localhost on SSH means the server. Manual `proxy_url` is preserved
when the switch is disabled and remains fallback if no automatic candidate works.
Timeout/scan-limit results mean detection was incomplete, not that all proxies failed.
Do not disable TLS validation or alter the system proxy to bypass detection failure.


When auto detection is enabled, manual/environment proxy fallback must also pass HTTPS
validation; a stale saved localhost port is not evidence of a working proxy. Check the
selected target's actual listener and protocol (HTTP versus SOCKS5), not just its port.
Automatic discovery enumerates all current-target TCP listener ports and their bound local addresses, without a hardcoded proxy-port list. Bounded parallel protocol probes precede ordered HTTPS checks; stop after the first working proxy. It does not scan other LAN hosts. Qoder/TRAE CDN icons
use the same target download proxy and bounded image data; browser proxy configuration
is not required for those icons. Re-scan after changing proxies to retry failed artwork.


For installation failures, inspect the specific plugin card's failure details. A
metadata-only plugin whose specific definitions/features remain deferred cannot become usable by
re-downloading it; explain the reported missing adapter. Do not classify all commands/agents as unsupported. Do not equate successful
marketplace registration with support for every entry. Hosted Qoder/TRAE packages may
contain several client manifests: KCoder retains the marketplace-selected adapter
through installation/discovery instead of choosing another vendor's manifest by order.


## Adapted Markdown Commands and Agents

After installing/enabling a supported prompt plugin, create a new conversation. Use the
exact namespaced entry from the skill catalog (or Studio's plugin trial entry); load it
with Skill, then follow its launcher: spawn_agent with plugin_agent equal to that exact
registered name and message containing the task/arguments. TUI and Studio use the same
registry and child runner. This is an adapter through the skill entry, not an alias for
every vendor's original slash command syntax.

The delegated task uses the active provider/model; vendor model aliases are not silently
resolved to another account. Agent `tools` lists restrict the child; `allowed-tools`
pre-approvals do not grant extra permissions and normal parent policy still applies.
Declared maxTurns caps and tool restrictions survive follow-up. Plugin instruction paths
are distinct from the task working directory. Follow the task workspace for user files.

Supported argument forms include full `$ARGUMENTS`, zero-based `$0`/`$ARGUMENTS[0]`, and
named arguments declared in frontmatter. Quoted arguments remain a single value; supplied
argument text is not recursively re-expanded. Plugin-root aliases and invoking-session,
skill-directory and project-directory variables are resolved without executing shell text.
Dynamic shell injection, per-agent hooks/permission overrides/memory modes and unsupported
host variables remain diagnosed. No command is executed merely by catalog discovery or
installation. Inspect compatibility issues when a plugin has a supported subset.
