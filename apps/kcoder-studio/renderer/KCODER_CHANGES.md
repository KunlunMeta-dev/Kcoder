# KCoder Studio Integration Boundaries

The production renderer in this directory connects only to the KCoder Gateway and the native `kcoder app-server`. Business objects uniformly report `runtime: "kcoder"`, and the model catalog uses `runtime.models.list`.

## Runtime Boundaries

- `src/kcoder/` centrally implements the Gateway WebSocket, task runtime, remote terminal, attachments, and browser adaptation.
- `src/kcoder/legacyRuntimeAbi.ts` is responsible only for string ABIs that have not yet been migrated; do not copy old aliases into other business files.
- Gateway targets must go through a real local or SSH `initialize` handshake, and must expose status, latency, and errors to the settings page.
- app-server sessions, tasks, transcripts, and models are the authoritative state; browser storage only persists UI state such as theme, layout, and drafts.
- Terminal, browser, and attachment resources are isolated by server, connection, and thread, and must be cleaned up in a bounded manner after disconnection.

## Client Capabilities

- The Gateway runtime supports task creation, follow-up turns, persistent session resumption, approvals, questions, and paginated transcripts.
- Remote terminals are provided through PTY JSON-RPC sessions, with bounded pre-connection output and exit status.
- The embedded browser is provided through an independent browser channel that supplies CDP frames and input events; it does not describe remote frames as a native WebView.
- The Electron host only loads the same production renderer, using random loopback sessions, strict CSP, permission denial, and subprocess environment cleanup.
- Mobile is an independent client that shares the Gateway and app-server protocol with desktop/Web, but does not share DOM components or device-level UI state.

## Verification Requirements

After modifying integration boundaries, at least run the renderer unit tests, Gateway contract tests, and the affected Electron, SSH, or browser E2E tests. Tests must use isolated credentials, ports, workspaces, and process groups, and must demonstrate that resource cleanup completed.