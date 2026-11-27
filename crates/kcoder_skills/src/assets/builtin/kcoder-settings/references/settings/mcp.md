# MCP Configuration and Troubleshooting

Read for MCP transport, scope, private configuration, enable/disable or failed connection. Use the actual execution target/account; installation, configuration, authorization, discovery and business-tool execution are distinct facts.

## Scope, JSONC and trust

First identify the target profile and effective sources with `kcoder config path` and a relevant `config get ... --source`. Project settings support the same JSONC comments/trailing commas as ordinary settings; the project trust pre-scan uses that same configuration reader, not a strict-JSON-only parser.

Use `kcoder trust status --path /absolute/project` to inspect trust. Add trust only when the user has authorized that project. Do not auto-trust a repository, copy its MCP definition into user settings to evade trust, or interpret a loading error as an empty server list.

## User-level CLI and effective observation

`kcoder mcp add` / `remove` modify the user layer; `add` creates stdio servers only:

```bash
kcoder mcp add local-files --command /absolute/path/to/mcp-server --args /absolute/path/to/workspace
kcoder mcp list
kcoder mcp test local-files
kcoder mcp remove local-files
```

These are operation examples, not an instruction to install/test during a read-only diagnosis. Use stable unique names and real target paths. `--args` accepts one or more values; comma-separated `--env` values cannot represent a value containing a comma, so use a reviewed settings edit for that non-secret value. For arguments beginning with `-`, inspect this build's CLI help instead of guessing shell quoting. `--env KEY=VALUE` stores literals in user settings; use it only for non-secret values.

`mcp list` and `mcp test` consume the command's already-resolved effective settings, including its cwd and explicit `--settings-file`; loading failures do not fall back to defaults. Listing reports configured/enabled entries, not a live connection. Test performs initialization and discovery, honors disabled servers/trust and returns a failure exit code on error. It does not execute a business tool. `/mcp verbose` observes the actual running session; a newly started command and an older resident session can have different snapshots.

## Transport and explicit project inheritance

Streamable HTTP uses `transport:"http"`; legacy HTTP+SSE uses `"sse"`. They are not interchangeable endpoints. Example non-secret configuration:

```json
{
  "mcp_servers": [{
    "name": "internal-http",
    "transport": "http",
    "url": "https://mcp.example.invalid/mcp",
    "policy": {"bearer_token_env_var": "EXAMPLE_MCP_TOKEN"}
  }]
}
```

An ordinary higher-layer `mcp_servers` array replaces the lower array, including an explicit empty array. Project shared settings alone can opt into retaining named lower-layer entries:

```json
{
  "mcp_inherited_servers": ["user-search"],
  "mcp_servers": [{"name":"project-docs","transport":"stdio","command":"/absolute/project-docs-server"}]
}
```

The names refer to current lower-layer definitions; do not copy their environment values, headers or credentials into the project file. The list must reference actual existing names and cannot duplicate a project-owned name. Empty means inherit none; null/omission does not opt in. Lists in user, executable, local or explicit overlay layers are rejected. Preview the actual source and confirm changes before writing a project array.

`mcp_disabled_servers` saves target-local disabled names, including plugin contributions. Disabled names are the union across layers; an empty higher-layer list does not re-enable a lower-layer deny. Studio's single-service enable switch retains configuration and authorization. New sessions do not connect/register disabled entries; existing connections/tools retain their session lifetime. Disabling is not deleting, uninstalling, or cancelling an already-running business call.

## Private environment, headers and credential references

Prefer the target's supported private setup form or environment references over embedding a secret. A stdio child receives the minimal system/profile/temp/locale environment plus explicitly permitted values, not the whole parent environment:

- `policy.env_vars` explicitly inherits named target-process variables; `env_aliases` maps target names to child names. Explicit `env` wins over aliases, then inherited values. Windows names are case-insensitive.
- `policy.env_http_headers` maps HTTP/SSE header names to target environment variable names; `bearer_token_env_var` builds the Bearer header. These are references, not shell expressions. Conflicting headers are rejected. Do not put a literal authorization header into project settings or CLI history.
- `required_env` / `required_headers` record missing private fields. Missing required values prevent process/network startup; they are not a reason to fabricate placeholder keys.
- A host private-credential transaction can produce `policy.credential_ref` with its opaque `cred-...` ID. Use the existing target UI/transaction; do not invent that ID, read the stored value into chat, or reuse a Provider credential slot. References are bound to the definition, profile and storage policy; changing command/endpoint/policy may require rebinding. File storage is not encryption; forced keyring does not fall back.

HTTP OAuth uses the host login/callback/logout flow. For separate accounts on the same app, use distinct `policy.oauth_account` slots (1–128 letters, digits, `_` or `-`) and authorize each slot. A slot cannot combine with `credential_ref`, `bearer_token_env_var` or an explicit Authorization header; a new/renamed slot needs authorization. Private environment references and native private fields together are bounded to 32, and descriptions/results are redacted against bound private values.

Provide required environment through the authorized target launcher or private form; a variable present only on the browser machine does not configure a remote target. Do not source an unknown environment file or rewrite shared launch settings without task authorization. External private-value migration previews, consent, save and revoke remain separate from connecting/enabling the MCP.

`policy.cwd` is an absolute stdio cwd. `workspace` preserves project scope. `enabled_tools` is optional and an empty list exposes none; `disabled_tools` wins. These filters apply to discovery and execution, not only the UI. `startup_timeout_secs` covers connection/handshake/discovery and `tool_timeout_secs` one request; both allow 1–3600 seconds. A timeout does not establish whether a remote side effect executed.

## Built-in Studio MCP Entries

The Studio MCP management page offers one-click entries. Each writes an ordinary `mcp_servers` entry into the selected target's user settings, enables it, and applies only to new conversations. An existing server with the same name is reported as already present and is not overwritten.

**SearXNG · built-in web search** writes `{"name":"searxng","transport":"searxng"}`. With no `url`, the full x64 Studio package's bundled SearXNG is started on a random `127.0.0.1` port; scanning port 8080 will not find it. The static `search` tool is registered at connect time and the service is verified and started on the first search, so a passing discovery or `mcp test` does not prove search works. An advanced external instance can be set with `url` (no credentials, query or fragment; the instance must allow the `json` format). Results are bounded titles, URLs and snippets; `incomplete` marks engines that failed, so an empty result is not proof that nothing exists. Verify with a real read-only `search` call in the target session, not with built-in `WebSearch`.

**Browser automation · Playwright** writes a stdio server named `playwright`:

```json
{"mcp_servers":[{"name":"playwright","transport":"stdio","command":"playwright-mcp","args":["--browser","chrome","--isolated","--output-dir","<Gateway data dir>/skill-runtime/playwright-mcp-output","--output-max-size","268435456"]}]}
```

- On Windows the command is `playwright-mcp.cmd`. The browser is `chrome` or `msedge` (Windows Gateway hosts default to Edge, others to Chrome) and must already be installed in its standard location; no browser is bundled or downloaded. Failures appear on the first browser tool call, not at discovery.
- Only local same-account Studio targets (local transport, no account isolation) have the launcher; SSH and account-isolated targets show the entry disabled. A local target missing the component needs a full reinstall. See [skills.md](skills.md#node-runtime-on-local-studio-targets).
- `--isolated` keeps the browser profile in memory: no personal cookies or sign-ins, and login state is lost when the browser closes. Unnamed outputs go to the private output directory (256 MiB cap); screenshots with an explicit filename resolve against the workspace.
- On Linux the stdio child has no `DISPLAY`, so the browser runs headless.
- Tools are `mcp__playwright__browser_*`. `browser_evaluate` and `browser_run_code_unsafe` run arbitrary page scripts. MCP tools are not read-only, so the target's `permission_mode` applies (`ask`/`auto`/`accept_edits` prompt per call, `dont_ask` denies, `bypass`/`yolo` do not prompt; new user configs default to `yolo`). To block one tool, add it to `denied_tools` (e.g. `mcp__playwright__browser_run_code_unsafe`) or to the server's `policy.disabled_tools`.
- New conversations in the same target process may reuse the cached connection and therefore the same browser; avoid driving it from several sessions at once.

## Verify the requested layer

1. Check effective configuration, scope/trust, enabled state and the actual session tool catalog.
2. Check the target command/cwd or transport URL and private bindings, without exposing their values.
3. If authorized, test initialization/discovery, then exercise the intended bounded read-only business tool. Never replace a failing MCP with another tool and call the MCP verified.
4. Keep original receipts for unknown business-call outcomes; do not blindly resend.

The `searxng` transport uses the installed bundled-service adapter. Successful registration or `mcp test` proves its adapter handshake/discovery, not external search availability: first search still loads/verifies/starts resources and queries engines. Report partial/incomplete search results accurately. Do not scan guessed fixed ports; the managed service uses an owned random loopback listener.

Model-facing MCP tools use the actual `mcp__<server>__<tool>` names. MCP and plugin tools are deferred by default in KWorker, KCoder and CLI/TUI: find them with `tool_search` and call them through `tool_execute`. Explicit `tools.studio` selections stay attached; `tools.defer_extensions: false` attaches them directly outside KWorker. A zero-match `tool_search` is not proof of absence: a tool may already be directly mounted or filtered by role, permission or keyword. Correct the specific error and verify a genuinely new conversation when a new registry snapshot is required; do not clear caches or restart every process by default.
