use crate::{QueryEngine, current_time_millis, recover_read_lock, recover_write_lock};
use kcoder_memory::{MemoryPromptInput, MemorySourceInput};
use kcoder_types::{ContentBlock, Message};
use serde_json::Value;
use tracing::{debug, warn};

impl QueryEngine {
    pub(super) fn next_memory_prompt_number(&self) -> u64 {
        let mut counter = recover_write_lock(&self.memory_prompt_counter, "memory_prompt_counter");
        *counter = counter.saturating_add(1);
        *counter
    }

    pub(super) fn current_memory_prompt_number(&self) -> Option<u64> {
        let counter = *recover_read_lock(&self.memory_prompt_counter, "memory_prompt_counter");
        (counter > 0).then_some(counter)
    }

    pub(super) fn record_user_prompt(&self, prompt_number: u64, prompt_text: &str) {
        if self.memory_private_by_default() && !self.memory_record_prompt_placeholders() {
            return;
        }
        let prompt_text = self.memory_prompt_text(prompt_text);
        let input = MemoryPromptInput {
            session_id: self.state.session_id(),
            prompt_number,
            prompt_text,
            created_at_epoch: current_time_millis(),
        };
        match self.memory_manager.save_structured_prompt(input) {
            Ok(Some(id)) => debug!(prompt_id = id, prompt_number, "recorded structured prompt"),
            Ok(None) => {}
            Err(error) => warn!("failed to record structured prompt: {error}"),
        }
    }

    pub(super) fn record_memory_source(
        &self,
        memory_kind: &str,
        memory_id: i64,
        source_type: &str,
        source_ref: Option<String>,
        metadata: Value,
    ) {
        let metadata = self.memory_source_metadata(source_type, metadata);
        let metadata_json = serde_json::to_string(&metadata).unwrap_or_else(|error| {
            warn!("failed to serialize memory source metadata: {error}");
            "{}".to_string()
        });
        let input = MemorySourceInput {
            memory_kind: memory_kind.to_string(),
            memory_id,
            source_type: source_type.to_string(),
            source_ref,
            metadata_json,
            created_at_epoch: current_time_millis(),
        };
        match self.memory_manager.save_structured_source(input) {
            Ok(Some(id)) => debug!(
                source_id = id,
                memory_kind, memory_id, "recorded memory source"
            ),
            Ok(None) => {}
            Err(error) => warn!("failed to record memory source: {error}"),
        }
    }

    fn memory_private_by_default(&self) -> bool {
        recover_read_lock(&self.settings, "settings")
            .memory
            .private_by_default
    }

    fn memory_record_prompt_placeholders(&self) -> bool {
        recover_read_lock(&self.settings, "settings")
            .memory
            .record_prompt_placeholders
    }

    fn memory_prompt_text(&self, prompt_text: &str) -> String {
        if !self.memory_private_by_default() {
            return prompt_text.to_string();
        }
        format!(
            "[prompt omitted because memory.private_by_default=true; chars={}]",
            prompt_text.chars().count()
        )
    }

    fn memory_source_metadata(&self, source_type: &str, metadata: Value) -> Value {
        if !self.memory_private_by_default() {
            return metadata;
        }
        minimized_memory_source_metadata(source_type, &metadata)
    }
}

pub(super) fn count_memory_prompt_candidates(messages: &[Message]) -> u64 {
    messages
        .iter()
        .filter(|message| match message {
            Message::User { content, .. } => {
                let has_tool_result = content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolResult { .. }));
                let has_text = content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::Text { .. }));
                has_text && !has_tool_result
            }
            Message::Assistant { .. } => false,
        })
        .count()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn minimized_memory_source_metadata(source_type: &str, metadata: &Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("private_by_default".to_string(), Value::Bool(true));
    out.insert(
        "source_type".to_string(),
        Value::String(source_type.to_string()),
    );

    let Some(object) = metadata.as_object() else {
        return Value::Object(out);
    };

    for key in [
        "tool_name",
        "observation_type",
        "verification_label",
        "recovery_kind",
        "verification_target",
    ] {
        if let Some(value) = object.get(key).and_then(safe_metadata_scalar) {
            out.insert(key.to_string(), value);
        }
    }

    for key in [
        "failed_attempts",
        "pre_compact_tokens",
        "post_compact_tokens",
    ] {
        if let Some(value) = object.get(key).and_then(safe_metadata_number) {
            out.insert(key.to_string(), value);
        }
    }

    for key in ["truncated"] {
        if let Some(value) = object.get(key).and_then(Value::as_bool) {
            out.insert(key.to_string(), Value::Bool(value));
        }
    }

    for key in ["files_modified", "files_read"] {
        if let Some(count) = object.get(key).and_then(Value::as_array).map(Vec::len) {
            out.insert(format!("{key}_count"), Value::Number(count.into()));
        }
    }

    Value::Object(out)
}

fn safe_metadata_scalar(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(Value::String(text.clone())),
        Value::Bool(flag) => Some(Value::Bool(*flag)),
        Value::Number(number) => Some(Value::Number(number.clone())),
        _ => None,
    }
}

fn safe_metadata_number(value: &Value) -> Option<Value> {
    value.as_i64().map(|n| Value::Number(n.into()))
}
