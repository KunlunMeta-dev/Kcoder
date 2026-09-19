use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

mod sanitization;
use sanitization::{failure_signature, pretty_json_limited, sanitize_json, sanitize_text};
mod ranking;
mod storage;
use storage::{STORE_VERSION, append_session_audit_log, example_file_path, persist_examples};
#[allow(unused_imports)]
pub(crate) use storage::{examples_dir, session_audit_log_path};

const MAX_SESSION_EVENTS: usize = 512;
const MAX_EXAMPLES_PER_SESSION: usize = 64;
const MAX_STRING_CHARS: usize = 360;
const MAX_ERROR_CHARS: usize = 600;
const MAX_JSON_CHARS: usize = 1_600;
const MAX_ARRAY_ITEMS: usize = 8;
const MAX_OBJECT_FIELDS: usize = 48;
pub(crate) const MODEL_REPAIR_HINT_LIMIT: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ToolRepairExample {
    pub version: u32,
    pub session_id: String,
    pub tool_name: String,
    pub schema_fingerprint: String,
    pub failure_signature: String,
    pub error_summary: String,
    pub failed_input: Value,
    pub successful_input: Value,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone)]
enum ToolRepairEvent {
    Failure {
        tool_name: String,
        schema_fingerprint: String,
        failure_signature: String,
        error_summary: String,
        input: Value,
        created_at_ms: u64,
    },
    Success {
        tool_name: String,
        schema_fingerprint: String,
        input: Value,
        created_at_ms: u64,
    },
}

#[derive(Debug, Clone)]
struct PendingFailure {
    tool_name: String,
    schema_fingerprint: String,
    failure_signature: String,
    error_summary: String,
    input: Value,
    created_at_ms: u64,
}

#[derive(Debug, Default)]
pub(crate) struct ToolRepairSessionRecorder {
    events: Vec<ToolRepairEvent>,
}

impl ToolRepairSessionRecorder {
    pub(crate) fn record_failure(
        &mut self,
        tool_name: &str,
        schema_fingerprint: &str,
        error_summary: &str,
        input: &Value,
    ) {
        self.push(ToolRepairEvent::Failure {
            tool_name: tool_name.to_string(),
            schema_fingerprint: schema_fingerprint.to_string(),
            failure_signature: failure_signature(error_summary),
            error_summary: sanitize_text(error_summary, MAX_ERROR_CHARS),
            input: sanitize_json(input),
            created_at_ms: now_millis(),
        });
    }

    pub(crate) fn record_success(
        &mut self,
        tool_name: &str,
        schema_fingerprint: &str,
        input: &Value,
    ) {
        self.push(ToolRepairEvent::Success {
            tool_name: tool_name.to_string(),
            schema_fingerprint: schema_fingerprint.to_string(),
            input: sanitize_json(input),
            created_at_ms: now_millis(),
        });
    }

    fn push(&mut self, event: ToolRepairEvent) {
        self.events.push(event);
        if self.events.len() > MAX_SESSION_EVENTS {
            let overflow = self.events.len() - MAX_SESSION_EVENTS;
            self.events.drain(0..overflow);
        }
    }

    pub(crate) fn persist_session_examples(&self, cwd: &Path, session_id: &str) -> Result<usize> {
        let examples = build_repair_examples(session_id, &self.events);
        let example_count = examples.len();
        if examples.is_empty() {
            append_session_audit_log(
                cwd,
                session_id,
                "no_examples",
                0,
                "session ended with no failed-to-successful tool repair examples to persist",
                None,
                None,
            )?;
            return Ok(0);
        }

        let examples_file = example_file_path(cwd, session_id);
        match persist_examples(cwd, session_id, &examples) {
            Ok(()) => {
                if let Err(error) = append_session_audit_log(
                    cwd,
                    session_id,
                    "wrote_examples",
                    example_count,
                    "session ended and wrote failed-to-successful tool repair examples",
                    Some(&examples_file),
                    None,
                ) {
                    warn!("failed to append tool repair session audit log: {}", error);
                }
                Ok(example_count)
            }
            Err(error) => {
                let error_message = error.to_string();
                if let Err(audit_error) = append_session_audit_log(
                    cwd,
                    session_id,
                    "write_failed",
                    example_count,
                    "session ended but failed to write tool repair examples",
                    Some(&examples_file),
                    Some(&error_message),
                ) {
                    warn!(
                        "failed to append tool repair session audit log after persistence failure: {}",
                        audit_error
                    );
                }
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ToolRepairIndex {
    examples: Vec<ToolRepairExample>,
}

pub(crate) fn schema_fingerprint(schema: &Value) -> String {
    let canonical = canonical_json(schema);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub(crate) fn format_repair_hints(examples: &[&ToolRepairExample]) -> String {
    if examples.is_empty() {
        return String::new();
    }
    if examples.len() == 1 {
        return format_single_repair_hint(examples[0], None);
    }

    let mut text = format!(
        "Top {} previous failed-to-successful repair examples from earlier sessions:",
        examples.len()
    );
    for (index, example) in examples.iter().enumerate() {
        text.push_str("\n\n");
        text.push_str(&format_single_repair_hint(example, Some(index + 1)));
    }
    text.push_str("\n\nUse the corrected JSON shapes, adapting values to the current task.");
    text
}

fn format_single_repair_hint(example: &ToolRepairExample, index: Option<usize>) -> String {
    let failed = pretty_json_limited(&example.failed_input);
    let successful = pretty_json_limited(&example.successful_input);
    let heading = match index {
        Some(index) => format!("Repair example {index} for `{}`", example.tool_name),
        None => format!(
            "A previous failed-to-successful repair example for `{}` from an earlier session",
            example.tool_name
        ),
    };
    let suffix = if index.is_some() {
        ""
    } else {
        "\n\nUse the corrected JSON shape, adapting values to the current task."
    };
    format!(
        "{}:\n\n\
         Failed call:\n```json\n{}\n```\n\n\
         Error:\n{}\n\n\
         Successful corrected call:\n```json\n{}\n```{}",
        heading, failed, example.error_summary, successful, suffix
    )
}

fn build_repair_examples(session_id: &str, events: &[ToolRepairEvent]) -> Vec<ToolRepairExample> {
    let mut pending_failures: Vec<PendingFailure> = Vec::new();
    let mut examples = Vec::new();
    let mut seen = HashSet::new();

    for event in events {
        match event {
            ToolRepairEvent::Failure {
                tool_name,
                schema_fingerprint,
                failure_signature,
                error_summary,
                input,
                created_at_ms,
            } => {
                pending_failures.push(PendingFailure {
                    tool_name: tool_name.clone(),
                    schema_fingerprint: schema_fingerprint.clone(),
                    failure_signature: failure_signature.clone(),
                    error_summary: error_summary.clone(),
                    input: input.clone(),
                    created_at_ms: *created_at_ms,
                });
            }
            ToolRepairEvent::Success {
                tool_name,
                schema_fingerprint,
                input,
                created_at_ms,
            } => {
                let Some(failure_index) = pending_failures.iter().rposition(|failure| {
                    failure.tool_name == *tool_name
                        && failure.schema_fingerprint == *schema_fingerprint
                }) else {
                    continue;
                };
                let failure = pending_failures.remove(failure_index);
                let dedupe_key = format!(
                    "{}\n{}\n{}\n{}",
                    tool_name,
                    failure.failure_signature,
                    canonical_json(&failure.input),
                    canonical_json(input)
                );
                if !seen.insert(dedupe_key) {
                    continue;
                }
                examples.push(ToolRepairExample {
                    version: STORE_VERSION,
                    session_id: session_id.to_string(),
                    tool_name: tool_name.clone(),
                    schema_fingerprint: schema_fingerprint.clone(),
                    failure_signature: failure.failure_signature,
                    error_summary: failure.error_summary,
                    failed_input: failure.input,
                    successful_input: input.clone(),
                    created_at_ms: failure.created_at_ms.min(*created_at_ms),
                });
                if examples.len() >= MAX_EXAMPLES_PER_SESSION {
                    break;
                }
            }
        }
    }

    examples
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => {
            let items = values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{items}]")
        }
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let items = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    format!("{key}:{}", canonical_json(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{items}}}")
        }
    }
}

#[cfg(test)]
#[path = "tool_repair/tests.rs"]
mod tests;
