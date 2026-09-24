# Studio Targets, Configuration Activation, and Failed Generation

Use this reference for Studio configuration and operational troubleshooting. Use [providers.md](providers.md) for model schema and [tui.md](tui.md) for terminal-specific interaction. Diagnose the current implementation; a roadmap is not proof of a shipped capability.

## Target and Identity First

Before reading or changing functional configuration, identify:

- The selected execution target: Windows/local, another local Gateway, or a remote SSH target.
- The remote KCoder account, if account login is enabled; otherwise the target's shared legacy environment.
- The workspace, effective settings sources/overlays and running target build. A local Studio version does not prove the remote app-server was upgraded. Read-only `kcoder doctor` on the relevant target can distinguish build commit/dirty state when versions alone cannot.

Remote model configuration and its connection validation belong on that remote target, within the authenticated KCoder account. A correctly configured remote model does not require copying its API key into the Windows local Provider list. If Windows-only edits appear effective, inspect routing, selection and higher-priority overlays before recommending duplicate configuration.

"Current computer/local" identifies an execution target, not the logged-in remote user. Gateway/browser profile, KCoder account, SSH transport user and workspace filesystem permissions are distinct. Do not use a local display identity such as `local@kcoder.local` as proof of remote account authentication.

People can share the SSH username/key and still use different KCoder accounts. Their models, credentials, sessions and extensions are account-owned; a new account does not inherit the administrator's private keys. Shared project access does not imply shared conversation history. Preserve normal SSH administration: do not disable SSH or change keys to fix Studio session visibility. Application isolation does not protect disk data from a host administrator with root access.

Studio supports API Key input in its model page. Explain the selected target/account's credential storage, keep secrets out of screenshots/logs/settings, and do not require `.env` editing as the only option. Do not suggest deleting a user's settings or profile to clear a stale catalogue.

## Skill Selection and Extension Ownership

In the Studio composer, type `$` or `/` to choose a discoverable Skill for the selected KCoder target/account. KCoder Skills are runtime capabilities, not features restricted to the model vendor: an OpenAI-, Anthropic-, MiniMax- or other configured model must not disable the Skill selector merely because of its provider. An unavailable/untrusted Skill is a target discovery/activation issue, not a reason to copy it into another provider profile.

Select an individual Skill, not an entire plugin. A plugin is an installation/ownership container; its MCP services provide tools after connection/authorization, and its Hooks run on lifecycle events. Neither is a Skill invocation. Plugin-owned components are managed with their plugin; independent components use their own management pages.

## Save, Apply, and New-Session Loading

| Change | Guidance |
| --- | --- |
| Add/edit a model | Wait for the target configuration to load before editing. The current Studio validates connectivity before committing; a successful save refreshes its catalogue without restarting Studio. New conversations and supported idle/next-turn selection use the saved configuration; an executing turn keeps its existing configuration. Check target capabilities and pending-apply/restart-required states for older servers. |
| Change a default | Distinguish the target default from an existing session's explicit selection. A model with the same display name in a different Provider is not the same identity. |
| Change a running session's configuration | Do not promise mid-stream mutation. Use the UI's supported idle Apply/model-selection workflow or start a new conversation; do not automatically terminate current work. |
| Change `tools.profile` | Save on the selected target/account, then create a new conversation. Existing resident sessions retain their tool set; an explicit CLI `--tool-profile` still overrides the setting. |
| Install/update plugin, Skill, Hook or MCP | Verify in a new conversation, after trust and required authorization are satisfied. Reopening a view attached to a resident runtime is not necessarily a new session. |
| Upgrade the executable | Newly written Markdown or a newer local installer does not update an already-running remote binary. Verify the target build and replace/restart the appropriate old process through its supported lifecycle. |

Model writes use the target snapshot revision (CAS). A genuine conflict preserves the draft: reread and review the changed target before reopening/reapplying; do not silently rebase or force-save stale values. Initial read failure leaves editing disabled until a successful retry. If a save response is lost, read the target to determine whether it committed before another write. Changing target or KCoder account invalidates in-flight UI work; never send an old account's draft/key to the new selection.

Current session configuration caches MCP using configuration, plugin generation, disabled tools and authorization revisions. Do not prescribe deleting caches or restarting every process by default. A missing optional MCP can leave a partial tool set; inspect its component-level failure and verify again in a new conversation after correcting it.

An installed plugin is not necessarily enabled, configured, authorized and connected. Plugin-owned components stay under that plugin's management. An OAuth callback means only that the callback arrived; saved credentials and successful MCP connection are separate states. Use [mcp.md](mcp.md), [plugins.md](plugins.md), [skills.md](skills.md) and [hooks.md](hooks.md) for their supported operations.

## Three Different Login Failures

| Failure | Correct scope |
| --- | --- |
| Gateway access/session token expired | Studio-to-Gateway authentication; do not fix by disabling Gateway authentication. |
| Remote KCoder account disabled, changed password, or revoked | That account/target needs valid authentication; it is not a reason to modify sshd. |
| MCP OAuth token missing, invalid, or expired | That MCP service's authorization; do not clear all model credentials or log out unrelated targets. |

For an idle/overnight login screen, identify which layer rejected access and inspect the relevant process/build. Do not claim the newly added failed-turn continuation automatically repairs login expiry, or guarantee that reconnect preserves running work after its owner disconnected.

## Generation Retry Versus Continuation

Separate three operations: automatic retries inside a model request; resending an input that was not accepted; and continuing an accepted turn after model generation failed. Increasing `max_retries` changes the first and does not convert a resend button into execution recovery.

Older Studio retry paths resent the previous user message via ordinary `turn/start`. Do not call that "resume at the failure point", and do not tell the model to replay completed Shell/file operations merely because generation failed later.

Targets with `failedTurnContinuationV1`, together with an updated Studio client, support explicit continuation for a standard foreground Provider-failed turn:

- Studio uses `turn/start` with empty `input` and `retryFromTurnId`; it does not append the original user input or rerun UserPromptSubmit.
- The target checks that this is the latest failed turn, the saved complete context still matches, and no tool call lacks a result. Previously submitted input, attachments and tool results remain available.
- The logical turn stays the same, while `turn/started.attemptId` distinguishes the new display stream. Do not infer a second user request from a separate displayed attempt.
- This restarts generation from the last complete context boundary, not from an arbitrary token in the broken network stream. The unfinished model response may be generated again. The executor does not replay completed tools to reconstruct their existing results.
- Successful continuation consumes the old failure; a later new Provider failure can be retried again. The existing execution gate rejects concurrent execution, but this is not a promise of a general exactly-once external side-effect system.

The operation is deliberately refused when the failure checkpoint is missing (including old-version records), history changed, a newer user turn exists, the result of a tool is unknown, or the failure belongs to an unsupported execution flow. Generic recovery for MoA/Orchestrate and arbitrary tool failures is not provided by this capability. It is not a new TUI command or an independent Mobile retry button; do not invent either from the Studio feature.

When continuation is refused, explain the reason and preserve the conversation. Repair credentials/connection only when the actual error calls for it; refreshing will not manufacture a missing checkpoint. Do not silently fall back to resending the original prompt, roll back files, delete history or claim that partial signed thinking is a valid resumable message. A supported new failure can be continued after restarting the app-server if the complete context and checkpoint still match.

## Built-in Reference Updates

These files are embedded in the KCoder executable and materialized into its managed `.builtin` layer. A source edit requires a rebuilt/deployed executable to reach another installation. User, external and project same-name skill overrides retain their existing precedence; inspect the activated source instead of deleting those overrides to force this guide.
