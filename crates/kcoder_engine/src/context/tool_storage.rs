use crate::context::truncate_chars_with_dropped_bytes;
use anyhow::{Context, Result};
use kcoder_types::ContentBlock;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tracing::{debug, warn};

/// Default maximum characters for a single tool result before it is persisted
/// to disk instead of being kept in the conversation. Matches the TypeScript
/// default of ~50k characters.
const DEFAULT_MAX_RESULT_SIZE_CHARS: usize = 50_000;

/// Default maximum aggregate characters for all tool results inside a single
/// user message. Matches the TypeScript aggregate cap of ~200k characters.
const DEFAULT_MAX_RESULTS_PER_MESSAGE_CHARS: usize = 200_000;

/// Preview size in bytes/characters for the reference message.
const PREVIEW_SIZE: usize = 2_000;

/// XML tag used to wrap persisted output messages.
const PERSISTED_OUTPUT_TAG: &str = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSING_TAG: &str = "</persisted-output>";

/// Message used when tool result content was cleared without persisting.
pub const TOOL_RESULT_CLEARED_MESSAGE: &str = "[Old tool result content cleared]";

/// Persistent storage for oversized tool results.
#[derive(Debug, Clone)]
pub struct ToolResultStorage {
    tool_results_dir: PathBuf,
    default_max_chars: usize,
    per_message_max_chars: usize,
    overrides: HashMap<String, usize>,
}

impl ToolResultStorage {
    pub fn new(session_dir: impl Into<PathBuf>) -> Self {
        Self {
            tool_results_dir: session_dir.into().join("tool-results"),
            default_max_chars: DEFAULT_MAX_RESULT_SIZE_CHARS,
            per_message_max_chars: DEFAULT_MAX_RESULTS_PER_MESSAGE_CHARS,
            overrides: HashMap::new(),
        }
    }

    /// Set per-tool persistence thresholds. A tool not present in the map uses
    /// the default cap.
    pub fn with_overrides(mut self, overrides: HashMap<String, usize>) -> Self {
        self.overrides = overrides;
        self
    }

    /// Ensure the tool-results directory exists.
    pub async fn ensure_dir(&self) -> Result<()> {
        fs::create_dir_all(&self.tool_results_dir)
            .await
            .with_context(|| format!("failed to create {:?}", self.tool_results_dir))
    }

    /// Resolve the effective persistence threshold for a tool.
    fn threshold_for(&self, tool_name: &str) -> usize {
        if let Some(&override_threshold) = self.overrides.get(tool_name) {
            return override_threshold;
        }
        self.default_max_chars
    }

    /// Enforce caps on all tool-result blocks contained in `messages`.
    ///
    /// Returns the number of tool results that were persisted/cleared.
    pub async fn enforce_on_messages(
        &self,
        messages: &mut [kcoder_types::Message],
    ) -> Result<usize> {
        let mut total_modified = 0;
        for msg in messages.iter_mut() {
            let content = match msg {
                kcoder_types::Message::User { content, .. } => content,
                kcoder_types::Message::Assistant { content, .. } => content,
            };
            total_modified += self.enforce_on_content(content).await?;
        }
        Ok(total_modified)
    }

    /// Enforce per-tool and per-message caps on a slice of content blocks.
    async fn enforce_on_content(&self, content: &mut [ContentBlock]) -> Result<usize> {
        let mut total_tool_result_chars: usize = 0;
        for block in content.iter_mut() {
            if let ContentBlock::ToolResult { content: inner, .. } = block {
                total_tool_result_chars += inner
                    .iter()
                    .map(|b| match b {
                        ContentBlock::Text { text } => text.len(),
                        _ => 0,
                    })
                    .sum::<usize>();
            }
        }

        let mut modified = 0;
        for block in content.iter_mut() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content: inner,
                ..
            } = block
            else {
                continue;
            };

            // Determine the owning tool name. The tool_use_id is unique per
            // invocation but does not encode the tool name. We therefore use a
            // generic threshold unless a caller has supplied a per-tool hint.
            // In practice the QueryEngine will call `enforce_tool_result`
            // directly when the tool name is known.
            let threshold = self.default_max_chars;

            let text_len: usize = inner
                .iter()
                .map(|b| match b {
                    ContentBlock::Text { text } => text.len(),
                    _ => 0,
                })
                .sum();

            let over_per_tool = text_len > threshold;
            let over_per_message =
                total_tool_result_chars > self.per_message_max_chars && text_len > PREVIEW_SIZE;

            if over_per_tool || over_per_message {
                match self.persist_tool_result(tool_use_id, inner).await {
                    Ok(info) => {
                        let preview = build_large_tool_result_message(&info);
                        *inner = vec![ContentBlock::Text { text: preview }];
                        modified += 1;
                    }
                    Err(e) => {
                        warn!(
                            "failed to persist tool result {} ({} chars): {}",
                            tool_use_id, text_len, e
                        );
                        // Fall back to in-place truncation rather than losing
                        // the result entirely.
                        truncate_text_blocks(inner, threshold);
                        modified += 1;
                    }
                }
            }
        }
        Ok(modified)
    }

    /// Enforce caps on a single tool-result block when the tool name is known.
    ///
    /// This is the preferred entry point used by `QueryEngine` after executing
    /// a tool, because it can apply per-tool thresholds.
    pub async fn enforce_tool_result(
        &self,
        tool_name: &str,
        tool_use_id: &str,
        content: &mut Vec<ContentBlock>,
    ) -> Result<bool> {
        let text_len: usize = content
            .iter()
            .map(|b| match b {
                ContentBlock::Text { text } => text.len(),
                _ => 0,
            })
            .sum();
        let threshold = self.threshold_for(tool_name);

        if text_len <= threshold {
            return Ok(false);
        }

        match self.persist_tool_result(tool_use_id, content).await {
            Ok(info) => {
                let preview = build_large_tool_result_message(&info);
                *content = vec![ContentBlock::Text { text: preview }];
                Ok(true)
            }
            Err(e) => {
                warn!(
                    "failed to persist tool result {} ({} chars): {}",
                    tool_use_id, text_len, e
                );
                truncate_text_blocks(content, threshold);
                Ok(true)
            }
        }
    }

    /// Persist a tool result to disk and return metadata about the file.
    async fn persist_tool_result(
        &self,
        tool_use_id: &str,
        content: &[ContentBlock],
    ) -> Result<PersistedToolResult> {
        let is_json = content.len() > 1 || !is_single_text_block(content);
        let filepath = self.tool_result_path(tool_use_id, is_json);

        // Extract only text blocks for persistence.
        let text_blocks: Vec<String> = content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect();

        let content_str = if is_json {
            serde_json::to_string_pretty(&text_blocks).unwrap_or_else(|_| text_blocks.join("\n"))
        } else {
            text_blocks.join("\n")
        };

        let original_size = content_str.len();

        // tool_use_id is unique per invocation, so skip if already persisted.
        if !filepath.exists() {
            self.ensure_dir().await?;
            fs::write(&filepath, &content_str)
                .await
                .with_context(|| format!("failed to write {:?}", filepath))?;
            debug!(
                "persisted tool result to {:?} ({} bytes)",
                filepath, original_size
            );
        }

        let (preview, has_more) = generate_preview(&content_str, PREVIEW_SIZE);

        Ok(PersistedToolResult {
            filepath,
            original_size,
            is_json,
            preview,
            has_more,
        })
    }

    fn tool_result_path(&self, tool_use_id: &str, is_json: bool) -> PathBuf {
        let ext = if is_json { "json" } else { "txt" };
        // tool_use ids come from the provider stream and are untrusted input:
        // keep only path-safe characters so a crafted id (containing `/`,
        // `..`, or an absolute path) cannot escape the results directory.
        let safe_id: String = tool_use_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let safe_id = if safe_id.is_empty() {
            "unknown".to_string()
        } else {
            safe_id
        };
        self.tool_results_dir.join(format!("{safe_id}.{ext}"))
    }
}

fn is_single_text_block(content: &[ContentBlock]) -> bool {
    content.len() == 1 && matches!(content.first(), Some(ContentBlock::Text { .. }))
}

fn truncate_text_blocks(content: &mut [ContentBlock], max_chars: usize) {
    for block in content.iter_mut() {
        if let ContentBlock::Text { text } = block
            && let Some((truncated, dropped_bytes)) =
                truncate_chars_with_dropped_bytes(text, max_chars)
        {
            *text = format!(
                "{}\n\n[... output truncated after {} characters; {} bytes omitted ...]",
                truncated, max_chars, dropped_bytes
            );
        }
    }
}

#[derive(Debug, Clone)]
pub struct PersistedToolResult {
    pub filepath: PathBuf,
    pub original_size: usize,
    pub is_json: bool,
    pub preview: String,
    pub has_more: bool,
}

fn generate_preview(content: &str, max_len: usize) -> (String, bool) {
    if content.len() <= max_len {
        return (content.to_string(), false);
    }
    let preview: String = content.chars().take(max_len).collect();
    (preview, true)
}

fn format_file_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn build_large_tool_result_message(result: &PersistedToolResult) -> String {
    let mut message = format!("{}\n", PERSISTED_OUTPUT_TAG);
    message.push_str(&format!(
        "Output too large ({}). Full output saved to: {}\n\n",
        format_file_size(result.original_size),
        result.filepath.display()
    ));
    message.push_str(&format!(
        "Preview (first {}):\n",
        format_file_size(PREVIEW_SIZE)
    ));
    message.push_str(&result.preview);
    message.push_str(if result.has_more { "\n...\n" } else { "\n" });
    message.push_str(PERSISTED_OUTPUT_CLOSING_TAG);
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::ContentBlock;

    #[tokio::test]
    async fn persists_large_tool_result() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = ToolResultStorage::new(tmp.path());

        let tool_use_id = "call_large";
        let mut content = vec![ContentBlock::Text {
            text: "x".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1000),
        }];

        let modified = storage
            .enforce_tool_result("bash", tool_use_id, &mut content)
            .await
            .unwrap();
        assert!(modified);

        let text = match &content[0] {
            ContentBlock::Text { text } => text,
            _ => panic!("expected text block"),
        };
        assert!(text.contains(PERSISTED_OUTPUT_TAG));
        assert!(text.contains(tool_use_id));
    }

    #[tokio::test]
    async fn skips_small_tool_result() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = ToolResultStorage::new(tmp.path());

        let mut content = vec![ContentBlock::Text {
            text: "small output".into(),
        }];
        let modified = storage
            .enforce_tool_result("bash", "call_small", &mut content)
            .await
            .unwrap();
        assert!(!modified);
        assert!(
            !tmp.path().join("tool-results").exists(),
            "small tool results should not create an empty storage directory"
        );
    }

    #[tokio::test]
    async fn skips_messages_without_persisted_results_without_creating_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = ToolResultStorage::new(tmp.path());

        let mut messages = vec![kcoder_types::Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
        }];

        let modified = storage.enforce_on_messages(&mut messages).await.unwrap();
        assert_eq!(modified, 0);
        assert!(
            !tmp.path().join("tool-results").exists(),
            "messages without persisted tool results should not create storage"
        );
    }

    #[test]
    fn tool_result_path_sanitizes_untrusted_tool_use_ids() {
        let storage = ToolResultStorage::new("/tmp/kcoder-tool-storage-test");
        for malicious in ["../../etc/passwd", "/abs/path", "a/b\\c", "..", ""] {
            let path = storage.tool_result_path(malicious, false);
            assert_eq!(
                path.parent().and_then(|p| p.file_name()),
                Some(std::ffi::OsStr::new("tool-results")),
                "id {malicious:?} escaped the results dir: {path:?}"
            );
        }
        let normal = storage.tool_result_path("toolu_01ABC-def_29", true);
        assert!(normal.ends_with("tool-results/toolu_01ABC-def_29.json"));
    }
}
