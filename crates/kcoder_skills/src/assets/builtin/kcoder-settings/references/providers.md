# Provider and Multi-Model on the Same API

Read this file when handling Provider/model settings. First confirm the current CLI, configuration directory, and scope per the main skill; do not mix the development and formal profiles, and do not add a model to the same API by copying a Provider ID or key.

## Boundaries Between Connection and Model

- `providers.<id>` is a connection and credential namespace: `api_format`, `chat_protocol`, `endpoint`, `authentication`, `credential_env`, proxy/timeout, and other deployment fields are shared.
- A non-empty `models` is the complete explicit model table keyed by real model ID. Each entry independently provides `context_window_tokens`, `output_headroom_tokens`, `max_output_tokens`; it may also independently declare `capabilities`, `reasoning_effort`, `extra_body`, `auto_compact_threshold_tokens`. Do not write endpoints or keys into model entries.
- `default_model` must be a key that already exists in the non-empty `models`. Adding a model does not automatically change the default model; when deleting or renaming the default entry, also update `default_model`.
- `active_provider` selects the default connection; that connection's `default_model` selects its default model. An explicit per-session model selection is not a default written to all new sessions.
- API keys are only handed to `kcoder auth` or Studio's authentication input, and must not appear in the configuration examples, project files, or docs below. A shared connection maintains only one credential; only different endpoints/authentication identities should consider an independent Provider.

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

Under a non-empty `models`, you do not need to repeat the three token limits at the Provider top level. Each Provider may have at most 1024 models explicitly configured. Model-entry values must be positive; output limits must not exceed the context window; the auto-compaction threshold must also satisfy the current effective context and output reserve validation rules. Do not only validate that JSON parses.

```bash
kcoder config validate --settings-file settings_models.jsonc --provider shared
kcoder config get providers.shared --source --settings-file settings_models.jsonc
```

`config validate` does not perform a model connectivity probe. Only after confirming the file is complete and the scope is correct, import per the user's request; a file declaring a Provider may change the complete connection list, so do not directly import the demo document into an existing configuration.

## Per-Model Extra Request Body

For new configuration, place extra fields in `providers.<id>.models.<model-id>.extra_body`, not at the Provider root. The complete example above deliberately clears the small model's body and gives the large model its own parameters; neither choice changes the sibling's effective body.

- Omitted model `extra_body` inherits a legacy Provider-level `extra_body`, if present.
- An explicit `{}` clears that model's body. It does not fall back to the Provider body.
- A non-empty model body replaces the legacy Provider body as a whole; do not assume a recursive merge between the two. Preserve every field the model still needs when replacing it.
- In current Studio, saving a model materializes legacy shared body values into existing model entries before clearing the shared root. Newly added models start empty. When migrating by hand, do the equivalent preservation explicitly; removing the root first can silently change sibling models.
- Studio negotiates `supportsModelExtraBody` and writes `modelExtraBody` in the RPC. On disk the field is `extra_body`. The old Provider-wide RPC `extraBody` write is rejected; do not switch to it to bypass capability checks.
- Studio accepts a JSON object up to 64 KiB for this field. Header names and values belong to the supported authentication/header configuration, not arbitrary body fields. Do not place API keys, OAuth tokens or passwords in `extra_body`.
- Do not replace runtime-owned `model`, `messages`, `input`, `system`, `instructions`, `tools` or `stream` through this object. Studio's validation probe rejects these fields; editing settings by hand is not an appropriate bypass.

Explicit extra fields can override generated request defaults, such as reasoning/temperature/output-format parameters. Check the selected protocol and effective body when a regular UI setting appears ineffective. Runtime-controlled recovery can deliberately remove reasoning fields; do not promise that every field is always forwarded unchanged. Avoid exporting entire request bodies in diagnostics: arbitrary JSON may contain sensitive user data even when it is not named `api_key`.

For model IDs containing dots/slashes, use the complete JSONC model-table import approach below rather than inventing dotted-key escape syntax. Read the existing target-layer table first and preserve its sibling models.

## Reasoning Capability, Request Parameters, and Returned Thinking

These are separate facts:

1. `capabilities.reasoning` declares the model capability. Checking the box does not by itself prove that a vendor-specific thinking parameter was sent.
2. `reasoning_effort` selects a supported default effort. The actual API format maps that selection to request fields; never invent `medium` when the target has no configured default or the model does not support it.
3. A model-specific `extra_body` can express vendor parameters not represented by the standard controls. Use the vendor's actual protocol requirements; a field used by one vendor or API format is not automatically valid for another.
4. Returned structured thinking must be decoded and displayed. A completed response without visible thinking is not, on its own, proof that configuration was ignored; some upstream responses omit it. Conversely, do not declare the UI correct without checking whether the provider actually returned reasoning events.

For OpenAI Chat-compatible services, Provider-level `chat_protocol` accepts `auto`, `standard`, or `minimax`. A relay can hide the upstream host identity: use the explicit `minimax` dialect only when that upstream really speaks the supported MiniMax Chat variant. This is not a universal thinking-on switch and does not replace selecting the correct Anthropic Messages or Responses `api_format`.

When diagnosing missing thinking, inspect in order: selected target/account → full Provider/model identity → effective capabilities/effort/model body → selected API format/dialect → safe response-event facts → Studio/TUI display. Do not add random headers or force a restart without identifying the failing stage. Partial thinking or a truncated tool-call JSON must not be fabricated into a completed assistant message.

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

Model IDs may contain dots or slashes, such as `GLM-5.3`. Do not concatenate such keys directly into a dotted key, or invent unvalidated escape syntax; use a JSONC snippet containing the full model table per the existing import flow, and preserve other models.

## Override, Deletion, and Effective Source

The scope order listed in the main skill still applies; first use `config list --sources` and `config get <key> --source` to check sources.

1. The union of Provider IDs declared by all explicit files determines the complete **Provider list**, not a model union. When an ID is still declared in another scope, deleting it in one place does not guarantee it disappears completely.
2. Once a Provider's `models` appears in a higher-priority file, it **entirely replaces** the lower layer's model table; merging is not done model-by-model in depth. When modifying one model, also keep all the other models and their full parameters that this layer intends to provide. Only when the higher layer omits `models` does the lower layer's table continue to be inherited.
3. `models: {}` reverts to legacy single-model semantics; unsetting `models` from a higher layer may re-expose the lower layer's table. Neither of these is "delete all models". To delete only one model, submit the complete non-empty table with that entry removed; to delete the last model, explicitly delete the entire API and check whether other scopes still declare it.
4. Default model deletion/rename and the new table must be committed as one consistent change; otherwise validation fails because `default_model` is not in the table. Before importing, check whether the target layer has other Providers, and preserve configuration outside the scope of this task.
5. Final runtime parameters are also affected by Provider/model selection: an explicit `--provider`/`--profile` applies the connection defaults, while `provider::model` applies the selected model's parameters and re-applies its context, output, and auto-compaction thresholds. You cannot just shrink the top-level `auto_compact_threshold_tokens` and assume the threshold still applies after selection. For multi-model, modify the corresponding `models` entry; for legacy single-model, modify the fields inside the Provider.

For example, when troubleshooting why pre-compaction is not triggering, in addition to `prefire_threshold_tokens`, also check the selected model's `auto_compact_threshold_tokens`, context, and output reserve. Validate using the same CLI arguments and overlay as the actual startup; do not only look at the top-level value in a single disk file. The top-level / in-model threshold and the normal scope merging are two stages; do not mistake "model selection resets parameters" for inverted project-layer priority.

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

If connectivity validation fails before saving, preserve the draft and diagnose the reported category; do not uniformly interpret errors as "insufficient quota" or bypass the save gate. The probe shares model resolution with real use but has bounded test output/time/retries. In particular, a large custom thinking budget may interact with a reduced probe output limit. Probe success is not acceptance of every tool, output budget or real task.

Saving and applying are separate states. Targets advertising `supportsNewSessionReload` can load committed configuration for a new conversation without exiting Studio. When the actual UI still shows pending Apply/restart, follow that target's capability and idle-apply workflow, reread the catalogue, and verify both old and new models. Do not claim that every existing session changes mid-turn, or require closing the whole app for every edit. See [studio.md](studio.md) for target ownership and extension lifetimes. Editing a shared endpoint/protocol/dialect/authentication/key affects all models of that API; adding a model should not incidentally change the connection.

The configuration/credential transaction can report a conflict or `[provider_transaction_pending]`. Refresh/read the target to recover and establish what committed before retrying; keep the unsaved draft and do not blindly repeat writes or manually delete a recovery journal. Successful configuration deletion and failed credential cleanup must be reported separately.

When the target does not declare `supportsMultipleModels`, do not probe capability by sending an added model under the same ID; legacy single-model services may overwrite the original model. Suggest upgrading the target KCoder, preserving existing single-model edits, and do not silently fall back to override behavior.

## Built-in Skill Upgrades

This reference updates with the built-in skill and is only materialized to the `.builtin` layer. User, external, and project same-name overrides still take effect at their existing priority; if the description does not change after an upgrade, check the actual activation source and do not delete the user's same-name `kcoder-settings` to force the built-in version.

### Explicit reasoning controls

`providers.<id>.models.<model>.reasoning_policy` is a user declaration, not verified vendor support. Use `{"mode":"optional","efforts":["none","high"]}` only when those exact efforts are supported, with `capabilities.reasoning:true` and a consistent `reasoning_effort`. Optional policy forbids thinking/reasoning overrides in `extra_body`, which would otherwise defeat the control. `always_on` / `always_off` require matching explicit effort or recognized body parameters and reject contradictions. `hidden` only hides the conversation control; effective configuration remains visible. Omission preserves legacy hidden controls without guessing supported efforts. Never add a policy solely from a model name; never add vendor request fields merely because a capability is enabled.
