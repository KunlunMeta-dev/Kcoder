use super::*;
use crate::tool_file_observation::{normalize_existing_path, normalize_tool_path};

fn spec_tool_mutates_files(tool_name: &str, tool_input: &Value) -> bool {
    matches!(
        tool_name,
        "SpecInit" | "SpecNewChange" | "SpecArchive" | "SpecSync"
    ) || (tool_name == "SpecConfig"
        && tool_input.get("action").and_then(Value::as_str) == Some("set"))
        || (tool_name == "SpecReview"
            && tool_input.get("action").and_then(Value::as_str) == Some("writeback"))
}

fn spec_mutation_paths(tool_name: &str, tool_input: &Value, cwd: &Path) -> Vec<String> {
    let specs_dir = cwd.join(".kcoder").join("specs");
    let path = match tool_name {
        "SpecInit" => specs_dir,
        "SpecConfig" => specs_dir.join("config.yaml"),
        "SpecReview" => tool_input
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .map(|name| specs_dir.join("changes").join(name))
            .unwrap_or(specs_dir),
        "SpecNewChange" | "SpecSync" => tool_input
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .map(|name| specs_dir.join("changes").join(name))
            .unwrap_or(specs_dir),
        "SpecArchive" => tool_input
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .map(|name| specs_dir.join("changes").join("archive").join(name))
            .unwrap_or(specs_dir),
        _ => specs_dir,
    };
    vec![normalize_existing_path(path, cwd)]
}

#[derive(Clone)]
pub(crate) struct EngineLifecycleHookEmitter {
    engine: QueryEngine,
}

impl EngineLifecycleHookEmitter {
    pub(crate) fn new(engine: QueryEngine) -> Self {
        Self { engine }
    }
}

#[async_trait::async_trait]
impl LifecycleHookEmitter for EngineLifecycleHookEmitter {
    async fn emit(&self, event: &str, query: String, data: Value) -> LifecycleHookResult {
        let Some(event) = kcoder_hooks::HookEvent::parse(event) else {
            return LifecycleHookResult {
                blocking_error: Some(format!("unknown lifecycle hook event `{event}`")),
                ..LifecycleHookResult::default()
            };
        };
        let (_events, effects, blocking_error) =
            self.engine.run_simple_hooks(event, query, data).await;
        LifecycleHookResult {
            messages: effects.messages,
            blocking_error: blocking_error.or(effects.blocking_error),
            prevent_continuation: effects.prevent_continuation,
            stop_reason: effects.stop_reason,
        }
    }
}

impl QueryEngine {
    /// Access the lifecycle hook registry.
    pub fn hook_registry(&self) -> &kcoder_hooks::HookRegistry {
        &self.hook_registry
    }

    pub(super) fn hook_input(
        &self,
        event: kcoder_hooks::HookEvent,
        query: impl Into<String>,
        data: Value,
    ) -> kcoder_hooks::HookInput {
        let permission_mode = {
            let settings = recover_read_lock(&self.settings, "settings");
            format!("{:?}", settings.permission_mode).to_ascii_lowercase()
        };
        kcoder_hooks::HookInput::new(event, query, data)
            .with_extra("session_id", serde_json::json!(self.state.session_id()))
            .with_extra("cwd", serde_json::json!(self.state.cwd()))
            .with_extra("permission_mode", serde_json::json!(permission_mode))
    }

    fn aggregate_hook_results(
        results: &[kcoder_hooks::HookResult],
    ) -> kcoder_hooks::AggregatedEffects {
        kcoder_hooks::AggregatedEffects::aggregate(
            results
                .iter()
                .filter_map(|r| match &r.outcome {
                    kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                    _ => None,
                })
                .collect(),
        )
    }

    fn hook_events_from_effects(effects: &kcoder_hooks::AggregatedEffects) -> Vec<EngineEvent> {
        effects
            .messages
            .iter()
            .map(|(text, is_error)| EngineEvent::HookMessage {
                text: text.clone(),
                is_error: *is_error,
            })
            .collect()
    }

    pub(super) async fn run_simple_hooks(
        &self,
        event: kcoder_hooks::HookEvent,
        query: impl Into<String>,
        data: Value,
    ) -> (
        Vec<EngineEvent>,
        kcoder_hooks::AggregatedEffects,
        Option<String>,
    ) {
        let input = self.hook_input(event, query, data);
        let results = kcoder_hooks::execute_hooks(&self.hook_registry, input).await;
        let effects = Self::aggregate_hook_results(&results);
        let mut events = Self::hook_events_from_effects(&effects);
        let blocking_error = kcoder_hooks::first_blocking_error(&results);
        if let Some(error) = &blocking_error {
            events.push(EngineEvent::HookMessage {
                text: error.clone(),
                is_error: true,
            });
        }
        (events, effects, blocking_error)
    }

    pub(super) async fn run_post_tool_failure_hooks(
        &self,
        tool_name: &str,
        tool_input: &Value,
        output: &ToolOutput,
    ) -> (
        Vec<EngineEvent>,
        kcoder_hooks::AggregatedEffects,
        Option<String>,
    ) {
        self.run_simple_hooks(
            kcoder_hooks::HookEvent::PostToolUseFailure,
            tool_name,
            serde_json::json!({
                "tool_name": tool_name,
                "tool_input": tool_input,
                "error": tool_output_text(output),
            }),
        )
        .await
    }

    pub(super) async fn run_success_lifecycle_hooks(
        &self,
        tool_name: &str,
        tool_input: &Value,
        output: &ToolOutput,
    ) -> Vec<EngineEvent> {
        if output.is_error {
            return Vec::new();
        }

        let mut events = Vec::new();
        for (event, query, data) in self.success_lifecycle_payloads(tool_name, tool_input, output) {
            let (mut hook_events, _effects, _blocking_error) =
                self.run_simple_hooks(event, query, data).await;
            events.append(&mut hook_events);
        }
        events
    }

    fn success_lifecycle_payloads(
        &self,
        tool_name: &str,
        tool_input: &Value,
        output: &ToolOutput,
    ) -> Vec<(kcoder_hooks::HookEvent, String, Value)> {
        let mut payloads = Vec::new();

        if matches!(tool_name, "write" | "edit")
            && let Some(path) = tool_input
                .get("file_path")
                .and_then(Value::as_str)
                .map(|path| normalize_tool_path(path, &self.state.cwd()))
        {
            payloads.push((
                kcoder_hooks::HookEvent::FileChanged,
                path.clone(),
                serde_json::json!({
                    "tool": tool_name,
                    "path": path,
                    "paths": [path],
                    "input": tool_input,
                }),
            ));
        }

        // apply_patch carries no `file_path` key; its affected paths live inside
        // the patch text (multi-file), so it gets its own block instead of a
        // name appended to the write/edit matches! above.
        if tool_name == "apply_patch"
            && let Some(patch) = tool_input.get("patch").and_then(Value::as_str)
        {
            let paths: Vec<String> = kcoder_tools::apply_patch::patch_affected_paths(patch)
                .into_iter()
                .map(|path| normalize_tool_path(&path, &self.state.cwd()))
                .collect();
            if !paths.is_empty() {
                payloads.push((
                    kcoder_hooks::HookEvent::FileChanged,
                    tool_name.to_string(),
                    serde_json::json!({
                        "tool": tool_name,
                        "paths": paths,
                        "input": tool_input,
                    }),
                ));
            }
        }

        if spec_tool_mutates_files(tool_name, tool_input) {
            let paths = spec_mutation_paths(tool_name, tool_input, &self.state.cwd());
            payloads.push((
                kcoder_hooks::HookEvent::FileChanged,
                tool_name.to_string(),
                serde_json::json!({
                    "tool": tool_name,
                    "paths": paths,
                    "input": tool_input,
                    "scope": "specs",
                }),
            ));
        }

        if tool_name == "SpecConfig"
            && tool_input.get("action").and_then(Value::as_str) == Some("set")
        {
            let key = tool_input
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            payloads.push((
                kcoder_hooks::HookEvent::ConfigChange,
                key.clone(),
                serde_json::json!({
                    "tool": tool_name,
                    "key": key,
                    "value": tool_input.get("value").cloned().unwrap_or(Value::Null),
                    "path": self.state.cwd().join(".kcoder/specs/config.yaml"),
                    "scope": "specs",
                }),
            ));
        } else if tool_name == "Config"
            && tool_input.get("value").is_some()
            && tool_output_text(output).trim_start().starts_with("Set ")
        {
            let setting = tool_input
                .get("setting")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            payloads.push((
                kcoder_hooks::HookEvent::ConfigChange,
                setting.clone(),
                serde_json::json!({
                    "tool": tool_name,
                    "setting": setting,
                    "value": tool_input.get("value").cloned().unwrap_or(Value::Null),
                    "scope": "settings",
                }),
            ));
        }

        payloads
    }

    /// Run startup lifecycle hooks that plugins can use to initialize external
    /// integrations or inject initial context.
    pub async fn run_startup_hooks(&self) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        for event in [
            kcoder_hooks::HookEvent::Setup,
            kcoder_hooks::HookEvent::SessionStart,
            kcoder_hooks::HookEvent::InstructionsLoaded,
        ] {
            let (mut hook_events, effects, _blocking_error) = self
                .run_simple_hooks(
                    event,
                    event.as_str(),
                    serde_json::json!({
                        "source": "startup",
                        "cwd": self.state.cwd(),
                        "session_id": self.state.session_id(),
                    }),
                )
                .await;
            for context in effects.additional_context {
                self.state.add_message(Message::runtime_text(format!(
                    "[hook:{}] {}",
                    event.as_str(),
                    context
                )));
            }
            events.append(&mut hook_events);
        }
        events
    }

    /// Run the `TeammateIdle` lifecycle hook. The REPL calls this when the
    /// main model is idle and a background teammate/sub-agent completion is
    /// about to trigger a follow-up turn.
    pub async fn run_teammate_idle_hooks(
        &self,
        query: impl Into<String>,
        data: serde_json::Value,
    ) -> (Vec<EngineEvent>, bool) {
        let (events, effects, blocking_error) = self
            .run_simple_hooks(kcoder_hooks::HookEvent::TeammateIdle, query, data)
            .await;
        let should_stop = blocking_error.is_some() || effects.prevent_continuation;
        (events, should_stop)
    }

    /// Run Stop hooks after the assistant has finished sampling.
    ///
    /// Returns engine events to yield and whether the turn should stop before
    /// executing any pending tools.
    pub(super) async fn run_stop_hooks(&self) -> (Vec<EngineEvent>, bool) {
        let input = self.hook_input(kcoder_hooks::HookEvent::Stop, "", serde_json::Value::Null);
        let results = kcoder_hooks::execute_hooks(&self.hook_registry, input).await;
        let effects = kcoder_hooks::AggregatedEffects::aggregate(
            results
                .iter()
                .filter_map(|r| match &r.outcome {
                    kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                    _ => None,
                })
                .collect(),
        );
        let mut events = Vec::new();
        let failures: Vec<Value> = results
            .iter()
            .filter_map(|result| match &result.outcome {
                kcoder_hooks::HookOutcome::Error(error) => Some(serde_json::json!({
                    "hook": result.hook_description,
                    "kind": "error",
                    "error": error,
                })),
                kcoder_hooks::HookOutcome::InvalidOutput(error) => Some(serde_json::json!({
                    "hook": result.hook_description,
                    "kind": "invalid_output",
                    "error": error,
                })),
                kcoder_hooks::HookOutcome::Effects(_) | kcoder_hooks::HookOutcome::Skipped => None,
            })
            .collect();
        if !failures.is_empty() {
            let (mut failure_events, _effects, _blocking_error) = self
                .run_simple_hooks(
                    kcoder_hooks::HookEvent::StopFailure,
                    "",
                    serde_json::json!({
                        "source": "Stop",
                        "failures": failures,
                    }),
                )
                .await;
            events.append(&mut failure_events);
        }
        for (text, is_error) in &effects.messages {
            events.push(EngineEvent::HookMessage {
                text: text.clone(),
                is_error: *is_error,
            });
        }
        if let Some(error) = kcoder_hooks::first_blocking_error(&results) {
            events.push(EngineEvent::HookMessage {
                text: error,
                is_error: true,
            });
            return (events, true);
        }
        (events, effects.prevent_continuation)
    }

    /// Run UserPromptSubmit hooks before adding the user message to history.
    ///
    /// Returns engine events, an optional modified user text, and an optional
    /// blocking error message.
    pub async fn run_user_prompt_submit_hooks(
        &self,
        text: &str,
    ) -> (Vec<EngineEvent>, Option<String>, Option<String>) {
        let input = self.hook_input(
            kcoder_hooks::HookEvent::UserPromptSubmit,
            "",
            serde_json::Value::String(text.to_string()),
        );
        let results = kcoder_hooks::execute_hooks(&self.hook_registry, input).await;
        let effects = kcoder_hooks::AggregatedEffects::aggregate(
            results
                .iter()
                .filter_map(|r| match &r.outcome {
                    kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                    _ => None,
                })
                .collect(),
        );
        let mut events = Vec::new();
        for (text, is_error) in &effects.messages {
            events.push(EngineEvent::HookMessage {
                text: text.clone(),
                is_error: *is_error,
            });
        }
        if let Some(error) = kcoder_hooks::first_blocking_error(&results) {
            return (events, None, Some(error));
        }
        let modified = effects
            .updated_input
            .and_then(|v| v.as_str().map(String::from));
        (events, modified, None)
    }

    /// Run PreCompact or PostCompact hooks and return any custom instructions
    /// and a blocking error.
    pub(super) async fn run_compact_hooks(
        &self,
        event: kcoder_hooks::HookEvent,
        current_instructions: Option<String>,
    ) -> (Option<String>, Option<String>) {
        let input = self.hook_input(
            event,
            "",
            serde_json::json!({
                "trigger": if event == kcoder_hooks::HookEvent::PreCompact {
                    "pre"
                } else {
                    "post"
                },
                "customInstructions": current_instructions,
            }),
        );
        let results = kcoder_hooks::execute_hooks(&self.hook_registry, input).await;
        let effects = kcoder_hooks::AggregatedEffects::aggregate(
            results
                .iter()
                .filter_map(|r| match &r.outcome {
                    kcoder_hooks::HookOutcome::Effects(e) => Some(e.clone()),
                    _ => None,
                })
                .collect(),
        );
        for (text, is_error) in &effects.messages {
            if *is_error {
                warn!("compact hook error: {}", text);
            } else {
                debug!("compact hook message: {}", text);
            }
        }
        if let Some(error) = kcoder_hooks::first_blocking_error(&results) {
            return (None, Some(error));
        }
        let mut instructions = current_instructions;
        for ctx in effects.additional_context {
            if let Some(ref mut inst) = instructions {
                inst.push_str("\n\n");
                inst.push_str(&ctx);
            } else {
                instructions = Some(ctx);
            }
        }
        (instructions, None)
    }
}

#[cfg(test)]
#[path = "tests/lifecycle_unit.rs"]
mod tests;
