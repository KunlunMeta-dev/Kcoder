use super::*;

/// Number of same-input tool failures before adding a stronger loop warning.
const REPEATED_TOOL_FAILURE_THRESHOLD: usize = 2;
/// Number of consecutive identical tool failures before adding a hard loop warning.
const CONSECUTIVE_IDENTICAL_TOOL_FAILURE_THRESHOLD: usize = 3;
/// Keep the failure tracker bounded; old entries are advisory only.
const MAX_TRACKED_TOOL_FAILURES: usize = 128;

#[derive(Debug, Clone)]
pub(super) struct ToolFailureRecord {
    pub(super) count: usize,
    pub(super) input_preview: String,
}

#[derive(Debug, Clone)]
pub(super) struct VerificationFailureRecord {
    pub(super) count: usize,
    pub(super) target: String,
    pub(super) command_preview: String,
}

#[derive(Debug, Default)]
pub(super) struct ToolFailureTracker {
    failures: HashMap<u64, ToolFailureRecord>,
    verification_failures: HashMap<String, VerificationFailureRecord>,
    consecutive_failure_key: Option<u64>,
    consecutive_failure_count: usize,
}

impl QueryEngine {
    pub(super) fn model_visible_tool_error(
        &self,
        name: &str,
        input: &Value,
        input_schema: Option<&Value>,
        error: &ToolError,
    ) -> ToolOutput {
        let mut output = tool_error_output(name, error, input_schema);
        self.record_tool_repair_failure(name, input, error);
        self.append_tool_specific_invalid_input_hint(name, input, error, &mut output);
        self.append_tool_repair_hint(name, input, error, &mut output);
        self.append_repeated_failure_warning(name, input, &mut output);
        output
    }

    pub(super) fn model_visible_timeout_error(
        &self,
        name: &str,
        input: &Value,
        timeout_ms: u64,
    ) -> ToolOutput {
        let mut output = ToolOutput::error(format!(
            "Tool `{}` timed out after {} ms. Do not retry unchanged unless the operation is expected to take longer; reduce the work, use a narrower input, or choose a different tool.",
            name, timeout_ms
        ));
        self.append_repeated_failure_warning(name, input, &mut output);
        output
    }

    pub(super) fn mark_tool_success(&self, name: &str, input: &Value) -> Option<ToolFailureRecord> {
        let key = tool_failure_key(name, input);
        let mut tracker = recover_write_lock(&self.tool_failure_tracker, "tool_failure_tracker");
        let recovered = tracker.failures.remove(&key);
        tracker.consecutive_failure_key = None;
        tracker.consecutive_failure_count = 0;
        drop(tracker);
        self.record_tool_repair_success(name, input);
        recovered
    }

    pub(super) fn mark_verification_failure(&self, tool_name: &str, input: &Value) {
        let Some(target) = verification_target_from_tool_input(tool_name, input) else {
            return;
        };
        let Some(command) = input.get("command").and_then(Value::as_str) else {
            return;
        };
        let mut tracker = recover_write_lock(&self.tool_failure_tracker, "tool_failure_tracker");
        if tracker.verification_failures.len() > MAX_TRACKED_TOOL_FAILURES {
            tracker.verification_failures.clear();
        }
        let record = tracker
            .verification_failures
            .entry(target.key.clone())
            .or_insert(VerificationFailureRecord {
                count: 0,
                target: target.display.clone(),
                command_preview: truncate_chars(command.trim(), 240),
            });
        record.count = record.count.saturating_add(1);
        record.target = target.display;
        record.command_preview = truncate_chars(command.trim(), 240);
    }

    pub(super) fn mark_verification_success(
        &self,
        tool_name: &str,
        input: &Value,
    ) -> Option<VerificationFailureRecord> {
        let target = verification_target_from_tool_input(tool_name, input)?;
        let mut tracker = recover_write_lock(&self.tool_failure_tracker, "tool_failure_tracker");
        tracker.verification_failures.remove(&target.key)
    }

    fn record_tool_repair_failure(&self, name: &str, input: &Value, error: &ToolError) {
        let ToolError::InvalidInput(detail) = error else {
            return;
        };
        let schema_fingerprint = self.schema_fingerprint_for_tool(name);
        recover_write_lock(&self.tool_repair_recorder, "tool_repair_recorder").record_failure(
            name,
            &schema_fingerprint,
            detail,
            input,
        );
    }

    fn record_tool_repair_success(&self, name: &str, input: &Value) {
        let schema_fingerprint = self.schema_fingerprint_for_tool(name);
        recover_write_lock(&self.tool_repair_recorder, "tool_repair_recorder").record_success(
            name,
            &schema_fingerprint,
            input,
        );
    }

    fn append_tool_repair_hint(
        &self,
        name: &str,
        input: &Value,
        error: &ToolError,
        output: &mut ToolOutput,
    ) {
        let ToolError::InvalidInput(detail) = error else {
            return;
        };
        let schema_fingerprint = self.schema_fingerprint_for_tool(name);
        let examples = self.tool_repair_index.best_matches(
            name,
            &schema_fingerprint,
            input,
            detail,
            tool_repair::MODEL_REPAIR_HINT_LIMIT,
        );
        if examples.is_empty() {
            return;
        }
        append_text_to_tool_output(output, &tool_repair::format_repair_hints(&examples));
    }

    fn append_tool_specific_invalid_input_hint(
        &self,
        name: &str,
        input: &Value,
        error: &ToolError,
        output: &mut ToolOutput,
    ) {
        if let Some(hint) = tool_specific_invalid_input_hint(name, input, error) {
            append_text_to_tool_output(output, &hint);
        }
    }

    pub(super) fn schema_fingerprint_for_tool(&self, name: &str) -> String {
        self.tool_input_schemas
            .get(name)
            .map(tool_repair::schema_fingerprint)
            .unwrap_or_else(|| "unknown".to_string())
    }

    pub(super) fn append_repeated_failure_warning(
        &self,
        name: &str,
        input: &Value,
        output: &mut ToolOutput,
    ) {
        let Some(warning) = self.repeated_failure_warning(name, input) else {
            return;
        };
        append_text_to_tool_output(output, &warning);
    }

    fn repeated_failure_warning(&self, name: &str, input: &Value) -> Option<String> {
        let canonical = canonical_tool_input(input);
        let key = tool_failure_key_from_canonical(name, &canonical);
        let input_preview = truncate_chars(&canonical, 240);
        let mut tracker = recover_write_lock(&self.tool_failure_tracker, "tool_failure_tracker");
        if tracker.failures.len() > MAX_TRACKED_TOOL_FAILURES {
            tracker.failures.clear();
        }
        if tracker.consecutive_failure_key == Some(key) {
            tracker.consecutive_failure_count = tracker.consecutive_failure_count.saturating_add(1);
        } else {
            tracker.consecutive_failure_key = Some(key);
            tracker.consecutive_failure_count = 1;
        }
        let consecutive_failure_count = tracker.consecutive_failure_count;
        let record = tracker.failures.entry(key).or_insert(ToolFailureRecord {
            count: 0,
            input_preview,
        });
        record.count += 1;
        record.input_preview = truncate_chars(&canonical, 240);
        if record.count < REPEATED_TOOL_FAILURE_THRESHOLD {
            return None;
        }

        let suppress_user_elicitation = self.permission_mode_suppresses_user_elicitation();
        let recovery_guidance = if suppress_user_elicitation {
            "choose a different tool, or make a reasonable assumption and continue without asking the user"
        } else {
            "choose a different tool, or ask the user a targeted question"
        };
        let mut warning = format!(
            "Repeated tool failure detected: this is failed attempt #{} for tool `{}` with the same or equivalent JSON input.\n\
             Stop retrying the same arguments. Re-read the error details and expected input example above, then change the JSON shape/values, {}. Input preview: {}",
            record.count, name, recovery_guidance, record.input_preview
        );
        if consecutive_failure_count >= CONSECUTIVE_IDENTICAL_TOOL_FAILURE_THRESHOLD {
            let critical_recovery = if suppress_user_elicitation {
                "Try a different tool, reduce or change the input, inspect the required schema/output from another angle, or make a reasonable assumption and continue without asking the user."
            } else {
                "Try a different tool, reduce or change the input, inspect the required schema/output from another angle, or ask the user a targeted question before continuing."
            };
            warning.push_str(&format!(
                "\n\nCRITICAL LOOP WARNING: tool `{}` has now failed {} consecutive times with exactly the same canonical input. This strongly suggests the current strategy is wrong or you are stuck in a retry loop. Do not call this tool again with the same arguments. {}",
                name, consecutive_failure_count, critical_recovery
            ));
        }
        Some(warning)
    }
}

fn tool_error_output(name: &str, error: &ToolError, input_schema: Option<&Value>) -> ToolOutput {
    let message = match error {
        ToolError::InvalidInput(detail) => {
            let mut message = format!(
                "Tool `{name}` input validation failed.\n\
                 Details: {detail}\n\
                 The tool was not executed.\n\
                 Retry with a complete JSON object that exactly matches the schema. \
                 Use JSON arrays `[...]` for array fields; do not send a single object `{{...}}` where an array is required."
            );
            if let Some(example) = input_schema.and_then(format_schema_example_for_prompt) {
                message.push_str("\nExpected JSON shape example:\n");
                message.push_str(&example);
            }
            if name == "AskUserQuestion" {
                message.push_str(
                    "\nExpected AskUserQuestion shape:\n\
                     {\"questions\":[{\"question\":\"...\",\"header\":\"short_label\",\"options\":[{\"label\":\"Option A\",\"description\":\"What happens if selected\"},{\"label\":\"Option B\",\"description\":\"What happens if selected\"}],\"multi_select\":false}]}\n\
                     Common mistakes: `questions` must be an array even for one question, and each question's `options` must be an array with 2-4 option objects.",
                );
            }
            message
        }
        ToolError::Execution(detail) => {
            let mut message = format!(
                "Tool `{name}` execution failed: {detail}.\n\
                 Retry only after changing the input or resolving the reported condition; repeated identical calls are unlikely to help."
            );
            if let Some(example) = input_schema.and_then(format_schema_example_for_prompt) {
                message.push_str("\nInput shape example for this tool:\n");
                message.push_str(&example);
            }
            message
        }
        ToolError::SandboxDenied { reason, output } => {
            let mut message = format!(
                "Tool `{name}` was denied by the sandbox: {reason}.\n\
                 Retry only after changing the command/input or receiving approval for a broader sandbox."
            );
            if let Some(output) = output.as_deref().filter(|text| !text.trim().is_empty()) {
                message.push_str("\nSandboxed output preview:\n");
                message.push_str(&truncate_chars(output, 1000));
            }
            message
        }
        ToolError::Aborted => {
            format!(
                "Tool `{name}` was aborted before it completed. Retry only if the abort cause has changed."
            )
        }
    };
    ToolOutput::error(message)
}

fn tool_specific_invalid_input_hint(
    name: &str,
    input: &Value,
    error: &ToolError,
) -> Option<String> {
    let ToolError::InvalidInput(detail) = error else {
        return None;
    };
    match name {
        "TodoWrite" => todo_write_invalid_input_hint(input, detail),
        _ => None,
    }
}

fn todo_write_invalid_input_hint(input: &Value, detail: &str) -> Option<String> {
    let items = input
        .get("TodoList")
        .or_else(|| input.get("todos"))
        .and_then(Value::as_array)?;
    let has_blank_string_item = items
        .iter()
        .any(|item| item.as_str().is_some_and(|text| text.trim().is_empty()));
    let has_string_item = items.iter().any(Value::is_string);
    if !(has_blank_string_item || has_string_item && detail.contains("expected object")) {
        return None;
    }

    let mut hint = String::from(
        "TodoWrite-specific correction:\n\
         - `TodoList` must be an array of todo objects, never placeholder strings. `{\"TodoList\":[\"\"]}` is invalid.\n\
         - If there is no concrete checklist to track yet, do not call TodoWrite again; continue with read/bash/grep or the next appropriate tool.\n\
         - If you do want a checklist, retry with real task objects, for example:\n\
         {\"TodoList\":[{\"content\":\"Inspect Codex TUI entrypoint\",\"activeForm\":\"Inspecting Codex TUI entrypoint\",\"status\":\"in_progress\"},{\"content\":\"Trace event loop\",\"activeForm\":\"Tracing event loop\",\"status\":\"pending\"}]}",
    );
    if has_blank_string_item {
        hint.push_str(
            "\n\nThe failed input contained a blank string item, which carries no task text and is preserved as an error so it cannot accidentally clear an existing TodoList.",
        );
    }
    Some(hint)
}

fn append_text_to_tool_output(output: &mut ToolOutput, text: &str) {
    if let Some(ContentBlock::Text { text: existing }) = output
        .content
        .iter_mut()
        .find(|block| matches!(block, ContentBlock::Text { .. }))
    {
        existing.push_str("\n\n");
        existing.push_str(text);
        output.is_error = true;
        return;
    }
    output.content.push(ContentBlock::Text {
        text: text.to_string(),
    });
    output.is_error = true;
}

pub(super) fn tool_output_text(output: &ToolOutput) -> String {
    content_blocks_plain_text(&output.content)
}

fn tool_failure_key(name: &str, input: &Value) -> u64 {
    let canonical = canonical_tool_input(input);
    tool_failure_key_from_canonical(name, &canonical)
}

fn tool_failure_key_from_canonical(name: &str, canonical_input: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    canonical_input.hash(&mut hasher);
    hasher.finish()
}

fn canonical_tool_input(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => {
            let items = values
                .iter()
                .map(canonical_tool_input)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{items}]")
        }
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            let items = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    format!("{key}:{}", canonical_tool_input(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{items}}}")
        }
    }
}
