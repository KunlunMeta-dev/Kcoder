# Provider and Multi-Model on the Same API

Read this file when handling Provider/model settings. First confirm the current CLI, configuration directory, and scope per the main skill; do not mix the development and formal profiles, and do not add a model to the same API by copying a Provider ID or key.

## Boundaries Between Connection and Model

- `providers.<id>` is a connection and credential namespace; the ID is case-sensitive. Shared deployment fields: `api_format` (required: `anthropic_messages`, `openai_chat_completions`, `openai_responses` or `gemini_generate_content`), `endpoint` (HTTP(S)), `chat_protocol`, `authentication`, `credential_env`, `no_proxy`, `request_timeout_secs`, `user_agent`, `max_retries`, `retry_base_delay_ms`, `discover_models` and Provider-level `response_limits`.
- `authentication` is `{"mode":"api_key"}` (default) or `{"mode":"none"}`; `none` is accepted only with `openai_chat_completions`. The reserved IDs `anthropic`, `openai`/`local`/`grok` and `gemini` must use their matching `api_format`; custom IDs choose any format explicitly.
- A non-empty `models` is the complete explicit model table keyed by real model ID. Each entry independently provides `context_window_tokens`, `output_headroom_tokens`, `max_output_tokens`; it may also independently declare `capabilities`, `reasoning_effort`, `reasoning_policy`, `extra_body`, `auto_compact_threshold_tokens` and `response_limits`. Model entries do not inherit Provider-level capabilities or effort, and every omitted `capabilities` field (`text`, `tools`, `vision`, `reasoning`, `structured_output`) defaults to `true`; write `false` explicitly for unsupported features. Do not write endpoints or keys into model entries.
- `default_model` must be a key that already exists in the non-empty `models`. Adding a model does not automatically change the default model; when deleting or renaming the default entry, also update `default_model`.
- `active_provider` selects the default connection; that connection's `default_model` selects its default model. An explicit per-session model selection is not a default written to all new sessions.
- API keys are only handed to `kcoder auth login --provider <id>` (prompted without echo, or `--env-file`), `kcoder auth import --env-file`, or Studio's authentication input, and must not appear in the configuration examples, project files, or docs below; `config set`/`unset` reject `*api_key` keys. The `credential_store` setting (`auto` default, `keyring`, `file`) and `auth login --store` choose the OS credential store or the user-only `credentials.json`; `auth migrate --to keyring|file` moves stored keys and `auth status` shows availability without values. A shared connection maintains only one credential; only different endpoints/authentication identities should consider an independent Provider.

## Multi-Model Example

Below is a complete credential-free configuration document that can be saved as `settings_models.jsonc` and validated against the schema/loader. `example.invalid` and `small`/`large` are placeholders and do not represent a connectable deployment; the values and capabilities are structural illustrations only and must be modified according to the actual model specification, and capabilities cannot be inferred from them. JSON is a valid JSONC subset.

```json
{
  "active_provider": "shared",
  "providers": {
    "shared": {
      "api_format": "openai_chat_completions",
      "endpoint": "https://example.invalid/v1",
      "authentication": { "mode": "api_key" },
      "default_model": "small",
      "models": {
        "small": {
          "context_window_tokens": 32000,
          "output_headroom_tokens": 4096,
          "max_output_tokens": 2048,
          "auto_compact_threshold_tokens": 24000,
          "extra_body": {},
          "capabilities": {
            "text": true, "tools": false, "vision": false,
            "reasoning": false, "structured_output": false
          }
        },
        "large": {
          "context_window_tokens": 128000,
          "output_headroom_tokens": 16384,
          "max_output_tokens": 8192,
          "auto_compact_threshold_tokens": 90000,
          "reasoning_effort": "medium",
          "extra_body": { "temperature": 0.2 },
          "capabilities": {
            "text": true, "tools": true, "vision": true,
            "reasoning": true, "structured_output": false
          }
        }
      }
    }
  }
}
```

Under a non-empty `models`, you do not need to repeat the three token limits at the Provider top level. Each Provider may have at most 1024 models explicitly configured. Model-entry token values must be positive and `output_headroom_tokens`/`max_output_tokens` must not exceed the context window. Before a request, the hard input limit (`context_hard_input_tokens`, else window minus output headroom) must be positive and below the window, `auto_compact_threshold_tokens` must be positive and below that hard limit, and `prefire_threshold_tokens` must be below the auto-compaction threshold. Do not only validate that JSON parses.

```bash
kcoder config validate --settings-file settings_models.jsonc
kcoder config get providers.shared --source --settings-file settings_models.jsonc
```

`config validate` merges and checks every active layer plus the overlay (it ignores `--provider`/`--model`), and does not perform a model connectivity probe. `config get` applies CLI selections, so add `--provider`/`--model` there to inspect a selection's effective values. Only after confirming the file is complete and the scope is correct, import per the user's request; a file declaring a Provider may change the complete connection list, so do not directly import the demo document into an existing configuration.

## Local Response Memory Limits

`providers.<id>.response_limits` optionally bounds one decoded model response. A model's `response_limits` overrides only the specified fields and inherits the rest from its Provider; omitted limits use the built-in defaults. These are local memory safeguards, never API request fields or token/context quotas. Preserve `max_output_tokens`, context headroom and compaction settings when adjusting them.

| Field | Default | Meaning |
| --- | --- | --- |
| `total_decoded_bytes` | 67108864 (64 MiB) | UTF-8 bytes of decoded text, thinking/signatures, tool identity and arguments across the response |
| `tool_arguments_bytes` | 16777216 (16 MiB) | Decoded argument bytes per tool call |
| `content_blocks` | 1024 | Total blocks, including blocks already stopped |
| `active_tool_calls` | 64 | Simultaneously open calls, measured by count rather than the numeric index |

All values must be positive; the per-tool bound cannot exceed the total bound, and the active-call count cannot exceed the block count. A stopped block does not refund response bytes or total blocks. Exceeding a limit returns `provider_response_limit` with a safe resource name and numeric limit, cancels that response and executes none of its pending tool calls. It does not truncate arguments, retry the same oversized response or fabricate a result. A frozen execution retains its captured limits; an older snapshot without this field inherits current settings. Change limits on the execution target/account, then start a new execution. Remote old builds do not gain this guard merely because the local Studio was updated.

## Per-Model Extra Request Body

For new configuration, place extra fields in `providers.<id>.models.<model-id>.extra_body`, not at the Provider root. The complete example above deliberately clears the small model's body and gives the large model its own parameters; neither choice changes the sibling's effective body.

- Omitted model `extra_body` inherits a legacy Provider-level `extra_body`, if present.
- An explicit `{}` clears that model's body. It does not fall back to the Provider body.
- A non-empty model body replaces the legacy Provider body as a whole; do not assume a recursive merge between the two. Preserve every field the model still needs when replacing it.
- In current Studio, saving a model materializes legacy shared body values into existing model entries before clearing the shared root. Newly added models start empty. When migrating by hand, do the equivalent preservation explicitly; removing the root first can silently change sibling models.
- Studio negotiates `supportsModelExtraBody` and writes `modelExtraBody` in the RPC. On disk the field is `extra_body`. The old Provider-wide RPC `extraBody` write is rejected; do not switch to it to bypass capability checks.
- Settings validation (CLI, TUI and Studio alike) limits the effective body to a 64 KiB JSON object, including an inherited Provider body. Header names and values belong to the supported authentication/header configuration, not arbitrary body fields. Do not place API keys, OAuth tokens or passwords in `extra_body`.
- Runtime-owned `model`, `messages`, `input`, `system`, `instructions`, `tools` and `stream` are rejected in `extra_body` at load time; there is no hand-editing bypass.

Explicit extra fields can override generated request defaults, such as reasoning/temperature/output-format parameters. Check the selected protocol and effective body when a regular UI setting appears ineffective. Runtime-controlled recovery can deliberately remove reasoning fields; do not promise that every field is always forwarded unchanged. Avoid exporting entire request bodies in diagnostics: arbitrary JSON may contain sensitive user data even when it is not named `api_key`.

## Reasoning Capability, Request Parameters, and Returned Thinking

These are separate facts:

1. `capabilities.reasoning` declares the model capability. Checking the box does not by itself prove that a vendor-specific thinking parameter was sent.
2. `reasoning_effort` selects a supported default effort. The actual API format maps that selection to request fields; never invent `medium` when the target has no configured default or the model does not support it.
3. A model-specific `extra_body` can express vendor parameters not represented by the standard controls. Use the vendor's actual protocol requirements; a field used by one vendor or API format is not automatically valid for another.
4. Returned structured thinking must be decoded and displayed. A completed response without visible thinking is not, on its own, proof that configuration was ignored; some upstream responses omit it. Conversely, do not declare the UI correct without checking whether the provider actually returned reasoning events.

For OpenAI Chat-compatible services, Provider-level `chat_protocol` accepts `auto` (default; it only recognizes official endpoints), `standard`, or `minimax`. A relay can hide the upstream host identity: use the explicit `minimax` dialect only when that upstream really speaks the supported MiniMax Chat variant. This is not a universal thinking-on switch and does not replace selecting the correct Anthropic Messages or Responses `api_format`.

When diagnosing missing thinking, inspect in order: selected target/account → full Provider/model identity → effective capabilities/effort/model body → selected API format/dialect → safe response-event facts → Studio/TUI display. Do not add random headers or force a restart without identifying the failing stage. Partial thinking or a truncated tool-call JSON must not be fabricated into a completed assistant message.

### Explicit reasoning controls

`providers.<id>.models.<model>.reasoning_policy` is a user declaration, not verified vendor support. Use `{"mode":"optional","efforts":["none","high"]}` only when those exact efforts are supported, with a consistent `reasoning_effort`. Optional policy forbids thinking/reasoning overrides in `extra_body`, which would otherwise defeat the control. `efforts` lists at most 8 values from `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; `optional` requires both `none` and an enabled effort, and a configured `reasoning_effort` must appear in a non-empty list. `optional`, `always_on` and `always_off` require `capabilities.reasoning:true`. `always_on` / `always_off` require matching explicit effort or recognized body parameters and reject contradictions. `hidden` only hides the conversation control; effective configuration remains visible. Omission preserves legacy hidden controls without guessing supported efforts. Never add a policy solely from a model name; never add vendor request fields merely because a capability is enabled.

## Compatibility with Legacy Single-Model Configuration

When `models` is absent or `models: {}` is explicit, the loader still synthesizes a legacy model from the Provider's `default_model` and top-level model parameters; this does not mean "delete all models". For example:

```json
{
  "active_provider": "shared",
  "providers": {
    "shared": {
      "api_format": "openai_chat_completions",
      "endpoint": "https://example.invalid/v1",
      "default_model": "small",
      "context_window_tokens": 32000,
      "output_headroom_tokens": 4096,
      "max_output_tokens": 2048,
      "capabilities": {
        "text": true, "tools": false, "vision": false,
        "reasoning": false, "structured_output": false
      }
    }
  }
}
```

When migrating, place the original default model and its actual limits/capabilities as the first entry of `models`, then add new models. Do not add only the new models and omit the old `default_model`. When falling back to an empty table, valid legacy top-level parameters must still be present; a configuration with only the multi-model fields cannot rely on an empty table to automatically obtain correct limits.

Model IDs may contain dots or slashes, such as `GLM-5.3`. `config get/set/unset` split keys on every `.` and have no escape syntax, so do not concatenate such IDs into a dotted key; read the existing target-layer table, then import a JSONC snippet containing the full model table (`kcoder config import --file <path> --scope <user|project|local>`), preserving sibling models.

## Override, Deletion, and Effective Source

The scope order listed in the main skill still applies; first use `config list --sources` and `config get <key> --source` to check sources.

1. The union of Provider IDs declared by all explicit files determines the complete **Provider list**, not a model union. When an ID is still declared in another scope, deleting it in one place does not guarantee it disappears completely.
2. Once a Provider's `models` appears in a higher-priority file, it **entirely replaces** the lower layer's model table; merging is not done model-by-model in depth. When modifying one model, also keep all the other models and their full parameters that this layer intends to provide. Only when the higher layer omits `models` does the lower layer's table continue to be inherited.
3. `models: {}` reverts to legacy single-model semantics; unsetting `models` from a higher layer may re-expose the lower layer's table. Neither of these is "delete all models". To delete only one model, submit the complete non-empty table with that entry removed; to delete the last model, explicitly delete the entire API and check whether other scopes still declare it.
4. Default model deletion/rename and the new table must be committed as one consistent change; otherwise validation fails because `default_model` is not in the table. Before importing, check whether the target layer has other Providers, and preserve configuration outside the scope of this task.
5. Final runtime parameters are also affected by Provider/model selection: an explicit `--provider`/`--profile` applies the connection defaults, while `provider::model` applies the selected model's parameters and re-applies its context, output, and auto-compaction thresholds. You cannot just shrink the top-level `auto_compact_threshold_tokens` and assume the threshold still applies after selection. For multi-model, modify the corresponding `models` entry; for legacy single-model, modify the fields inside the Provider.

For example, when troubleshooting why pre-compaction is not triggering, in addition to `prefire_threshold_tokens`, also check the selected model's `auto_compact_threshold_tokens`, context, and output reserve. Validate using the same CLI arguments and overlay as the actual startup; do not only look at the top-level value in a single disk file. The top-level / in-model threshold and the normal scope merging are two stages; do not mistake "model selection resets parameters" for inverted project-layer priority.

## Model discovery and real context windows

On supporting targets, Studio Models/API can fetch a service's published model IDs from an unsaved endpoint/protocol/authentication draft. An existing connection's saved key is reused only when endpoint, protocol and authentication policy still match; changing endpoint requires a new key. A non-local plaintext HTTP target requires the existing explicit confirmation. The target performs discovery; do not copy a remote key into local settings or send a model-generation request just to enumerate IDs.

A discovered ID is not proof of access, tool/vision capability or context/output allowance. Do not choose the first catalog model automatically. When listing is unsupported or fails, preserve the draft and offer manual model entry, then offline save and connection Test as separate operations.

`context_window_tokens`, `output_headroom_tokens` and root `context_hard_input_tokens` control local budgeting/compaction/send checks; they do not resize the model server. For Ollama, a larger client value does not change the loaded `num_ctx`; use the service's supported configuration/model setup only if the user requested that server change. Do not assume an OpenAI-compatible endpoint accepts native `options.num_ctx` through extra_body.

Studio's supported saved-model “Ollama window check” reads loaded-model metadata, without generation, model loading or changing budgets. It uses the canonical `/v1` base to read the same-origin `/api/ps`, preserves deployment prefixes, follows proxy settings, sends no Provider credentials and refuses redirects. Authentication, unloaded models, ambiguous matching and transport failures remain unverified; a metadata snapshot is not a guarantee about a later multi-node request. Ordinary connection Test does not establish the server's actual window.

## Credential backend and overlays

`credential_store` is `auto`, `file` or `keyring`. Auto prefers the OS store and uses its documented fallback when unavailable; file uses a private credentials document and does not imply encryption; forced keyring refuses storage when the OS store is unavailable. `credentials.json` can hold references as well as file-mode keys. Inspect `kcoder auth status` or the target's redacted credential status, never raw credential contents. Changing the policy does not itself migrate existing keys; `kcoder auth migrate --to file|keyring` is an explicit credential migration requiring the right target and the user's intent.

`--credential-env-file` is a per-run override, not a settings overlay or a file to copy into shared Home. Do not print keys, replace the credential document or delete private migration metadata to fix a missing marker. Preserve other Providers, plugin/MCP namespaces and concurrent changes. A new Provider definition is not a credential and does not establish a default model; new product profiles have no preconfigured service/model.

Default model output allowances are 262144 tokens, including Wiki stages, summary/session-memory writers and MoA. Explicit limits and available context still bound actual requests; inherited defaults may be clipped for a smaller window without rewriting an explicit cap. This is separate from response memory limits, embedding/reranking limits and the server's own capacity. Inspect actual configured/frozen values rather than assuming an upgrade overwrote saved limits.

## CLI and Studio Operations

After confirming the model is configured, explicitly carry the Provider identity to avoid picking the wrong connection when different connections share the same model name:

```bash
kcoder --model 'shared::large'
```

Use `/model shared::large` in the TUI. Do not merge two models just because their names are the same; display names may be identical, but the full identity is the Provider plus the model ID. When authentication is needed, use a matching case-sensitive Provider ID, e.g., `kcoder auth login --provider shared`, and do not create a separate credential per model.

The Studio settings page distinguishes three kinds of actions:

- **Add API**: create a new connection; if the ID already exists, choose edit or "Add model under this API" instead of overwriting it as a new API.
- **Add model under this API**: reuse the existing connection and credentials; the new model does not have "set as default" checked by default. Context and capabilities are filled in independently; editing a model/rename pointing to the original model does not affect sibling entries.
- **Delete model / Delete the entire API**: the former keeps the connection, key, and sibling models; when deleting this API's default model, you must select a replacement under the same API. The last model cannot be deleted alone. Deleting the entire API removes all models; if it is the global default API, you must select another API; clearing credentials is a separate explicit choice.

Current capable Studio targets separate offline Save and connection Test. A failed probe preserves the draft/result and reports the actual category; it does not prevent a valid offline save. Legacy targets may still combine save with probing; do not bypass that target contract. The probe shares model resolution with real use but has bounded test output/time/retries. In particular, a large custom thinking budget may interact with a reduced probe output limit. Probe success is not acceptance of every tool, output budget or real task.

Saving and applying are separate states. Targets advertising `supportsNewSessionReload` can load committed configuration for a new conversation without exiting Studio. When the actual UI still shows pending Apply/restart, follow that target's capability and idle-apply workflow, reread the catalogue, and verify both old and new models. Do not claim that every existing session changes mid-turn, or require closing the whole app for every edit. See [studio.md](studio.md) for target ownership and extension lifetimes. Editing a shared endpoint/protocol/dialect/authentication/key affects all models of that API; adding a model should not incidentally change the connection.

The configuration/credential transaction can report a conflict or `[provider_transaction_pending]`. Refresh/read the target to recover and establish what committed before retrying; keep the unsaved draft and do not blindly repeat writes or manually delete a recovery journal. Successful configuration deletion and failed credential cleanup must be reported separately.

When the target does not declare `supportsMultipleModels`, do not probe capability by sending an added model under the same ID; legacy single-model services may overwrite the original model. Suggest upgrading the target KCoder, preserving existing single-model edits, and do not silently fall back to override behavior.

## Built-in Skill Upgrades

This reference updates with the built-in skill and is only materialized to the `.builtin` layer. User, external, and project same-name overrides still take effect at their existing priority; if the description does not change after an upgrade, check the actual activation source and do not delete the user's same-name `kcoder-settings` to force the built-in version.

## Effective Configuration and Wiki-only Model

Inspect effective source, current executing-turn snapshot and next-turn configuration separately. A probe evaluates the selected target's next configuration, does not mutate it, and is invalidated by configuration/credential/owner changes. Clearing a user override removes only the explicitly reviewed writable user keys under CAS; intentional project/CLI overlays stay authoritative.

`knowledge.organization_model` optionally selects a qualified model solely for Wiki organization; `knowledge.organization_reasoning_effort` optionally selects that worker's effort. Omit/null inherits the existing selection. These do not change ordinary conversation defaults or the current image-extraction model. Jobs freeze the actual resolved semantics and report model, effort, stage progress and known usage; unavailable usage is not zero. Stage requests use bounded analysis/generation budgets under the actual provider output/context ceilings; do not promise the maximum Wiki ceiling is sent on every batch.

## Provider Retry Waiting Hints

Both native and SDK-backed streaming HTTP errors preserve the selected Retry-After header as parsed retry metadata, including valid seconds and HTTP dates. Only positive waits under one hour are kept; other values are ignored; authentication/permanent failures do not become retryable merely because they carry this header. Existing retry limits (default `max_retries` 5 after the first request and `retry_base_delay_ms` 2000 with doubling; explicit global/Provider values and `--max-retries` override; training mode forces 0), exponential backoff and execution deadlines still apply. An HTTP 429/529 with a large rejected error body retains its HTTP status and waiting hint without exposing original body/header text in diagnostics. Do not confuse retry waiting with a disconnected desktop worker or override local response memory limits to recover a provider overload.
