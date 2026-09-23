# Plugin and Marketplace Management

Read this file only when the task involves discovering, installing, enabling/disabling, uninstalling, or troubleshooting plugin/marketplace.

## Capability and Compatibility Boundaries

KCoder can read native manifests, as well as Agent Plugins v1, `.codex-plugin`, `.claude-plugin`, and `.cursor-plugin`. When an external manifest does not explicitly declare contributions, it also follows the convention to discover `skills/`, `hooks/hooks.json`, `.mcp.json`/`mcp.json`, and `commands/`.

The current runtime activates Skills, MCP servers, and command Hooks. Commands and Apps/connectors are only parsed and reported as deferred; they are not pretended to be available; hosted remote marketplace is also not yet implemented. `fully_supported` means all declared capabilities of the plugin are supported; `partially_supported` means at least one capability is deferred. `plugin doctor`'s `healthy: true` only indicates that the manifest, contributions, and managed state are consistent; it does not mean all capabilities are activated, nor that the external process can be started.

A plugin ID is the stable `<name>@<marketplace>`. Local directory installs use `@local`; built-in offline bundles use `@kcoder-bundled`; subsequent read, doctor, enable, disable, and uninstall all pass the full ID, do not just guess the name.

## Audit First, Then Install

A Plugin is an executable extension: Hooks can run commands in lifecycle events and affect tool input, stdio MCP will spawn local processes, and HTTP/SSE MCP will connect to network services. Before installing, at minimum check:

- Repository and license, pinned commit/SHA or npm integrity.
- manifest, Hook JSON, all scripts called by Hooks, MCP command/args, package scripts, and dependencies.
- File write scope, network access, subprocesses, credential reading, and whether code is dynamically downloaded.
- Hook's project root judgment. Should be tested in an isolated project root with clear markers such as `.git` or `package.json` to avoid the plugin scanning overly large parent directories by walking up on its own.

Do not auto-trust plugin source code just because the marketplace can list the plugin. If auditing is not yet complete after installing an unfamiliar plugin, disable it first, and do not start a new session.

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

External command Hooks receive `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, and `PLUGIN_ROOT` at runtime, all pointing to the actual plugin copy. The `${CLAUDE_PLUGIN_ROOT}`, `${CODEX_PLUGIN_ROOT}`, and `${PLUGIN_ROOT}` in MCP configuration expand to that directory; if the script still cannot find it, first use `plugin read` to confirm the actual `root`, then check file permissions and whether the interpreter exists.

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
