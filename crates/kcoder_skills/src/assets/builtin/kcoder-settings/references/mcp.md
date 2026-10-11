# MCP Configuration and Troubleshooting

Read this file only when the task involves adding, removing, migrating, or diagnosing MCP servers.

## Confirm Scope and Trust First

Run `kcoder config path` to confirm the current profile. Project-level MCP comes from `.kcoder/settings.json` or `.kcoder/settings.local.json`, and should only be enabled after the user has explicitly approved the directory:

```bash
kcoder trust status --path /absolute/project
kcoder trust add --path /absolute/project
```

Do not auto-trust unfamiliar repositories. The current project MCP trust pre-scan uses strict JSON; when project settings declare `mcp_servers`, do not use comments or trailing commas, otherwise trust filtering cannot reliably identify server names.

## User-Level stdio Server

`mcp add` and `mcp remove` only modify user settings, and `add` only creates stdio transport:

```bash
kcoder mcp add local-files \
  --command /absolute/path/to/mcp-server \
  --args /absolute/path/to/workspace

kcoder mcp list
kcoder mcp test local-files
kcoder mcp remove local-files
```

Use a stable and unique server name, a resolvable command, and explicit arguments. When the argument starts with `-`, first use `kcoder mcp add --help` to check the current Clap parsing method; do not guess argument boundaries from shell strings.

The current `mcp list` / `mcp test` internally uses `Settings::load()` and cannot serve as definitive evidence that project-level or explicit `--settings-file` overlays have taken effect. The authoritative verification of project MCP is to run `/mcp verbose` in a new session.

## HTTP, SSE, and Project Configuration

Streamable HTTP uses `transport: "http"`; the legacy HTTP+SSE uses `transport: "sse"`. These two, as well as project-level stdio servers, are written directly to the target settings:

```json
{
  "mcp_servers": [
    {
      "name": "internal-http",
      "transport": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  ]
}
```

`mcp_servers` is an array; a higher-priority configuration's array entirely replaces the lower-priority array, and is not merged by name. Before modifying a project, first use `config list --sources` and `config get mcp_servers --source` to check the final source, to avoid accidentally overwriting the user's servers.

## Credentials and Process Environment

- `--env KEY=VALUE` writes the literal value into user settings and is only used for non-sensitive parameters.
- stdio servers can inherit necessary environment from the parent process that started KCoder; keys are preferably provided by a controlled launcher, secret manager, or restricted-permission wrapper.
- HTTP `headers` are plaintext literals in settings, with no environment variable expansion. Do not put bearer tokens into team project configuration; when truly needed, choose machine-private configuration or a local authentication proxy, and inform about storage risks.
- Do not put tokens into command history, examples, logs, or skill bodies.

## Verification and Troubleshooting

Check in order:

1. `kcoder config validate`.
2. `kcoder trust status --path <project>`.
3. Whether the stdio command exists and is executable, and whether the working directory and arguments are correct.
4. For user-level stdio servers, `kcoder mcp test <name>` can be run.
5. Start a brand-new session and run `/mcp verbose` to confirm the server, transport, tool count, and errors.
6. Model-side tool names use the `mcp__<server>__<tool>` prefix; if name collisions or missing tools occur, rely on `/mcp verbose` output.

Old sessions do not automatically obtain MCP tools added after startup. When a connection test fails, stop adding more servers and first fix the first deterministic error.
