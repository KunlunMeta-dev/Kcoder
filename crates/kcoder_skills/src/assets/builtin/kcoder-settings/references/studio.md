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

## Workspace File Upload

Use the workspace file panel's Upload files action to transfer local files into the selected execution target's current folder, including a Linux SSH target. Files are streamed in bounded chunks; each file is limited to 100 MiB, and multiple files can be selected. A same-name file requires an explicit Overwrite or Cancel upload choice; overwrite rechecks the confirmed destination revision. Uploading files is distinct from attaching evidence to a conversation. The target must advertise `workspaceFileImportV1`; update its KCoder binary if the capability is missing. Changing target/account cancels the old upload rather than sending its resource IDs to another target.

## Skill Selection and Extension Ownership

In the Studio composer, type `$` or `/` to choose a discoverable Skill for the selected KCoder target/account. KCoder Skills are runtime capabilities, not features restricted to the model vendor: an OpenAI-, Anthropic-, MiniMax- or other configured model must not disable the Skill selector merely because of its provider. An unavailable/untrusted Skill is a target discovery/activation issue, not a reason to copy it into another provider profile.

Select an individual Skill, not an entire plugin. A plugin is an installation/ownership container; its MCP services provide tools after connection/authorization, and its Hooks run on lifecycle events. Neither is a Skill invocation. Plugin-owned components are managed with their plugin; independent components use their own management pages.

## Save, Apply, and New-Session Loading

| Change | Guidance |
| --- | --- |
| Add/edit a model | Wait for the target configuration to load before editing. Current targets separate offline Save from connection Test. A failed or unrun probe does not block a valid offline save; older targets may retain their legacy save/test gate. A successful save refreshes the catalogue without restarting Studio. New conversations and supported idle/next-turn selection use the saved configuration; an executing turn keeps its existing configuration. Check target capabilities and pending-apply/restart-required states for older servers. |
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

## Conversation-first Workflows

Prefer natural-language requests over requiring library pages or JSON forms. When attached, `WorkflowDraft` can list, read, create, update, save, clone, import and export definitions in Studio or TUI. `read` with an explicit `version` returns the immutable saved definition; without `version` it returns the editable draft. For reuse, read the chosen saved version and its input schema, ask in chat for missing required information, then execute only when requested with `Workflow`. Do not substitute the current draft's schema for a historical version. Import creates an unpublished draft with a new ID.

Studio's “Reuse workflow” selector is optional assistance: it inserts a version reference into the current conversation without executing. Users can describe their requirements in chat; manual parameter forms and JSON are optional. A `workflow_draft` design session deliberately cannot execute nodes; use an ordinary conversation for execution. Operations not present in the attached registry must not be claimed as available.

Workflow reliability is a definition/runtime contract, not a Provider tuning switch. Prefer deterministic Code/Transform/Tool nodes for data processing. On targets advertising `workflowNodeContractsV1`, nodes support `config.inputBindings` for required JSON-pointer data and `config.resultCheck` for pure JavaScript postconditions (`input,nodes,bindings,result`, return exactly true). Missing bindings or failed checks stop the run; well-formed schema-invalid outputs are not rewritten by an Agent. Read back actual output artifacts before checking them. `completed` reports execution completion; graph output `verification` identifies only the explicitly configured checks, not every user requirement. Repair an existing graph in conversation and save a new version; do not silently change its live pinned run. `Workflow` needs exactly one source: `definition_id` plus `version`, `resume`, or one JavaScript source. `args_json` is a lossless alternative to `args`, never a substitute for selecting the saved workflow.


## Sub-agent Details and Targeted Adjustments

Click an existing agent in the conversation status list or the real workflow node to inspect public activity, output, historical pages and command receipts. Viewing/closing details does not start or stop the agent; the parent composer stays mounted and unsent drafts survive closing. Independent stop is available only for a supported actual background run. User questions need runtime-bound source metadata; an unverified or legacy source stays a parent interaction. General agents can ask only when the actual parent tool profile and bound host permit it; specialized/unattended roles and normal permissions remain restricted.

Send an adjustment with one stable client message ID. A transport or persistence failure can occur after commit: query that original ID, never silently generate a replacement. Applied means the worker checkpoint received the command, not that the requested outcome is achieved. Admission `backgroundRun` and actual `appliedBackgroundRun` are distinct; an absent application identity is unknown, not the current header's run. The target keeps bounded receipts and requires exact epoch confirmation before explicit archive. Parent context receives control metadata at a safe provider boundary; a linked workflow run is marked modified without changing its pinned definition.

## Workflow Verification and Version Storage

Keep graph/static checks separate from runtime evidence. After generation, offer verification and execute only when the user explicitly requests it. Review a named scenario's exact saved version, bounded input, expected checks and deliberately skipped checks; one passed scenario does not prove every branch or general reusability. Actual evidence records the run, attempt, definition fingerprint, target/model and checked/skipped scope. User adjustments and resumed attempts cannot be presented as an unchanged original version passing.

Use Workflows' verification, history and storage surfaces for their negotiated target capabilities. Archived historical versions can be inspected but not run as if currently saved. Migration, rollback and version archive require explicit review/confirmation and preserve pinned/active/unknown-effect references. Layout polling may use conditional reads; reconnect preserves the visible snapshot and does not silently overwrite an unsaved editor draft.

## Desktop Authorization and Recovery

On capable Windows targets, a user-approved conversation grant supports later operations without another permission dialog. Modern `useSessionAuthorization:false` means fresh explicit approval; true only inherits a still-valid grant. An absent flag on old clients is per-turn approval and expires with the turn. Account/connection/thread or plugin-policy changes revoke the old grant; enabling the plugin again does not revive it.

Authorization, worker channel availability and cleanup are separate facts. On an uncertain input outcome, query/observe; do not repeat Click/Type automatically. Studio's explicit recovery uses the original resident client, confirms the old session's worker/input/resource cleanup and starts an observation-only turn. A successful full observation is required before input; DisplayInventory, a crop, or Snapshot with both UI tree and vision disabled cannot satisfy that gate. A text-only model can use accessibility data; it does not acquire image interpretation. A locked/noninteractive desktop must be reported, not bypassed. A reused turn ID with a new attempt or lease does not authorize a stale cleanup receipt.

## Wiki Stages and Resume

Wiki retrieval and automatic organization have independent switches on the selected target. Disabling organization pauses scheduling without disabling retrieval. New jobs on current targets persist source analysis, topic planning and individual topic candidates; Studio displays the actual stage and known topic counts. Expand details for diagnostics rather than interpreting elapsed time as percentage complete.

For a failed or paused job, use its stage-specific Continue action to resume the same job. Completed, still-valid stage artifacts are reused; failed, missing or invalidated work is repeated. A complete received response is private input to parsing and verification, not proof that a knowledge page is ready. Truncated responses cannot be reused as complete output. Page edits invalidate dependent candidates; source revisions, purpose and frozen model configuration remain part of the recovery identity. Do not promise reuse after changing those inputs or erase the Wiki to fix one failed topic. Legacy jobs keep their previous checkpoint recovery format.

Local and remote workers admit two jobs concurrently, coordinating automatic page merges within each library. Waiting for that merge slot is a real stage, not a dead model connection. Normal source-support verification uses the global model-call budget independently of the three-repair allowance; missing evidence and unresolved coverage still require review. Increasing output limits does not override factual checks or a model's actual capacity. Inspect target build, source revision, stage error and frozen job model settings before recommending a restart or changing credentials.


A Wiki job marked for review may have no complete candidate on older targets. Current targets expose `reviewAvailable:false` for that state and permit Continue on the same job; do not call approval on an empty checkpoint or delete the source. Ordinary model `notes`/`warnings` are advisory, while explicit `reviewNotes`/`unresolvedIssues` remain blocking. Accepted wire variations and unique whitespace-only quote restoration do not replace the final source and revision checks. These rules apply to every imported format after extraction, including images, text, PDF, Office and HTML.


## Conversation Replacement and Scheduled-Task Refresh

Restoring/importing a conversation, explicitly rewinding its messages or clearing its context invalidates read snapshots belonging to the removed context. An unchanged file must be read again when its earlier tool result is absent; the new conversation can then reuse its own repeated-read placeholder. No-op rewinds retain cache; failed restore/import leaves the old conversation and cache intact. On current targets, rewind prepares the change and commits its history boundary before removing messages or read snapshots. A definite boundary-write failure preserves the old context. Concurrently appended messages survive a committed rewind and subsequent restoration. An uncertain write or a failure after committing the boundary requires recovery; do not report it as a clean rollback or blindly repeat the rewind. This is not a new file freshness setting and does not replace format=raw/fresh for machine data consumers.

Scheduled-task lists remain bound to target/workspace and the authenticated execution identity. Same-target title/status updates do not invalidate pending responses or restart polling; changing account/authority still rejects old results. A few seconds offset from a recurring nominal time may be existing deterministic jitter (default 30-second range), rather than a timezone parsing failure. Inspect nominal schedule and jitter separately before changing them.


## Memory and Shell Output Freshness

Project Markdown and global JSON memory reads refresh observable external changes. Invalid or unreadable files preserve the last valid cached facts; they are not silently replaced with empty data. Windows size/mtime checks are freshness hints, not immutable file snapshots. An intentionally empty offline memory store does not discover a file until explicitly written successfully. These are runtime safeguards, not new user configuration keys.

Background command output is a bounded live snapshot. Current builds coalesce updates over a 250 ms interval, refresh pending output while pipes are quiet, and flush on EOF or pipe error. Complete snapshots are atomically replaced; a write failure retains the last file and permits a later or final retry. This does not add separate command-stdout streaming events to chat or guarantee filesystem success. Shell output limits and explicit unlimited mode are unchanged. Startup Shell snapshots use their own 1 MiB stdout / 64 KiB stderr budgets, reject oversized source rather than publishing truncated scripts, and retain isolated-shell fallback. The 10-second build/verification limits and three-day retention are unchanged. Unix snapshot processes own a process group; Windows cleanup guarantees the native child only, not all WSL descendants.


New project-memory Markdown headers explicitly mark JSON-string encoding for category/source. Use the current runtime to read these fields; do not strip escapes, split raw category/source across header lines, or invent a settings key for the encoding. Current builds also read legacy unmarked headers literally. Older binaries may display JSON quotes/escapes when reading new headers, so this is not full two-way format compatibility.

Wiki source retries must confirm immutable object publication before committing database references, including when matching content already exists. A directory-sync failure is a storage failure, not a model-format error; preserve the source and retry once the storage issue is resolved. This does not promise complete cross-file transactions or Windows directory durability.

Current private agent checkpoints and final managed task outputs use complete atomic replacements. Same-process writers participating in this helper serialize the same absolute path, retaining their publication gate after cancellation of an async waiter. Public transcript projection remains separate and best effort; it is not a two-file atomic transaction or a guarantee that all task resource writers have stopped.

File previews release accumulated temporary chunks when changing file/target or closing the panel, and after successful completion. Late responses cannot replace the new selection. Progress refreshes only when the displayed integer percentage changes; the protocol, size limits and file-revision checks are unchanged. An already-sent RPC still runs until its response or timeout, and the resulting File/Blob may retain its own browser-owned bytes; do not promise zero-copy or a full streaming preview.


New source builds associate sub-agent public projections with private recovery checkpoints using a private publication receipt. A changed checkpoint can repair an outdated public copy without returning raw thinking, signatures or the receipt through the artifact API. Legitimate live progress may be ahead of disk; unknown active legacy projections and exact nonempty live extensions are preserved conservatively. This is not a complete freshness or two-file transaction guarantee. Recovery retains the existing 16 MiB private-conversion budget and never falls back to exposing the private file.

Wiki library writes confirm the newly created library directory entry on Unix, including retries of an existing directory. Archive-import cleanup checks settled database authority before removing unpublished objects. When publication is uncertain or authority cannot be read, retain objects and reopen the catalog before retrying the identical request key; do not delete the Wiki to work around that error. This adds no configuration key or Windows directory-durability promise.

Selecting a directory while a file is loading clears that preview's loading state and progress. Late file responses cannot overwrite the selected directory; reopening the file starts a fresh request.


Current document previews use one explicit FileViewer source owner. A normal first mount reads each File once rather than reissuing the same read through mount and update effects. Source, metadata or options changes reload deliberately; an explicit Retry is a fresh read. Failed render promises show a current-source error and retry button, and old success/failure cannot replace the new file. Loading/error surfaces disable keyboard interaction with the underlying old viewer. Existing presets, file types, size limits, File inputs and dependency versions remain unchanged. Each preview now uses a private renderer registry. A session guard is installed before the core receives renderer resources; it disposes each session once and catches synchronous or asynchronous destroy failures so the core can clear its source and observers and load the next document. Frozen sessions and methods with private fields retain their original receiver. Cleanup failures produce a static diagnostic without document content. This does not implement range streaming, browser zero-copy or force recovery of opaque renderer resources that its own destroy failed to release; lifecycle-hook failures remain distinct.


Current builds deduplicate pending conversation transcript requests only within the same ExecutorClient and valid account context. Account/executor changes reject stale results before normalization/cache use, while same-client cross-pane requests still share work. A pending restore restarts when its loader changes; an already completed valid restore remains visible without repeated reads on token refresh.

Persisted tool result paths now contain bounded readable ID prefixes plus the complete raw-ID and content SHA identities. Reused or sanitized-colliding provider IDs do not redirect a new preview to old bytes. Valid identical files are verified before reuse; corrupt or symlinked files are not accepted as cache hits. Full output spills use unique names and private no-replace atomic publication. Publication failure retains the existing truncation fallback and screenshot/non-text content; do not recommend changing context thresholds or clearing old references. Previously saved path references remain readable without a migration. Cancellation may leave an unreferenced complete artifact; this is not a guarantee of cleanup against every late or external writer.

Wiki store opening confirms the canonical object-root entry on Unix even when that directory already exists, so a failed prior creation cannot bypass confirmation on reopen. This check runs once per store open rather than on every read/write. Storage confirmation errors should be resolved before reopening; Windows keeps its existing directory-sync semantics.


Workspace text saves validate UTF-8 and SHA-256 across the full original file with a bounded 64 KiB reader, preserving split multibyte characters and BOM bytes. This reduces validation buffering, not the total bytes read or the model context limit. The existing 256 KiB new-content limit, stale-revision and truncated-preview refusal, permission preservation and atomic replacement behavior remain unchanged. A correct full-file revision retains the existing save semantics; this is not a new preview stream or a cross-process atomic compare-and-swap.


Wiki status views check running/queued jobs every two seconds and idle/terminal jobs every fifteen seconds, so work started or resumed from another conversation/client can appear without manual refresh. Returning online or to the foreground checks immediately; hidden pages stop observation, not the backend job. Complete job overviews retain account isolation and stop further paging when their observation is obsolete. List refreshes invalidate stale pagination and release old page-loading state; successful retry clears the old error. These changes do not alter model budgets or automatically rerun jobs.


Quick-phrase settings read saved preferences before allowing edits; a failed read offers Retry and never saves an assumed empty list. Create from the header, edit by selecting phrase content, and use its action menu to reorder or delete; deletion still asks for confirmation and a failed save keeps the draft. These are client interface preferences, not target model/tool settings. Shared action menus use themed surfaces and reachable mobile controls, support Arrow/Home/End navigation, and return focus when dismissed. Escape closes a focused menu before its enclosing editor.


### Session configuration templates

In Settings → Models → Configuration details, create a template or choose a JSON/JSONC file. Imports open the editor for review; they do not save or change a running session automatically. Click a template name to edit; its action menu sets/clears the new-session default or opens a delete confirmation. The default is displayed by template name. These operations target the selected runtime and serialize reads and writes; they do not cancel a write already accepted by the target when leaving the page.

A failed catalog refresh keeps the last known list and offers retry. Failed saves keep the editor and its draft; failed deletes keep the confirmation and error for retry. Saving applies the authoritative save response without an extra list request. Controls are disabled during pending operations; errors do not silently clear stored templates. Read errors do not mean the catalog is empty. Existing sessions keep their bound settings as documented above.


### Plugin network status and artwork recovery

The plugin proxy control preserves the last confirmed setting if a status refresh fails, and offers Retry without reopening the page. Pending status reads cannot overwrite a newer confirmed enable/disable result; repeated catalog invalidations coalesce into a trailing refresh. A setting write still follows the selected runtime/account and the existing proxy-port detection policy.

Plugin icons display a ready preferred asset without waiting for the optional light-theme read. Missing or undecodable dark artwork can fall back to a light asset; a proxy update invalidates failed-image state and allows the same URL to be retried. In-flight reads still share the scoped API cache and retain the four-request concurrency limit. A failed old request cannot remove a newer replacement cache entry. This does not imply that plugins without artwork acquire an icon, or that proxy detection makes every external marketplace reachable.


### Compact plugin page navigation

Plugin catalog, management and creation routes automatically remove the permanent sidebar from windows at or below 960px. The page menu or titlebar sidebar action opens navigation over the content; Close or Escape dismisses it and returns focus. Widening the window restores the stored sidebar preference; entering compact navigation does not persist a collapse setting. Project dialogs and inline rename retain their own Escape behavior. Installation target details expand to show the complete runtime/workspace path without changing where a plugin is installed.


### Failed workspace upload batches

A failed file upload batch offers Retry for its unconfirmed remaining files. Retrying does not resend files with confirmed receipts and keeps the original destination even if the file browser moves to another folder. Confirmed counts are cumulative across attempts. The selected runtime/workspace and account revision must still match; switching targets or accounts discards the local retry queue, and dismissing the feedback releases it. This queue is local to the mounted file panel, not a persisted background transfer.

Retries are explicit user actions. Each remaining file still starts with overwrite disabled and uses the existing revision-based conflict confirmation; a lost success response can therefore require confirmation on retry. Cancelling suppresses late progress, shows Cancelling until pending cleanup settles, and does not undo already confirmed files. File-list refresh is displayed as a separate phase and can stop the next file without misreporting the current committed receipt.


## Interface language and slash menus

Choose the interface language in Studio Settings → General → Language. Built-in slash-command descriptions, menu groups, loading feedback and command errors follow that choice, including a live switch between Chinese and English. Command identifiers such as `/plan`, `/goal-pro`, `/compact` and `/model` remain stable. Interface language is a client preference; do not write an invented language key through Config or treat it as the selected target's model configuration.
