use crate::{
    Tool, ToolContext, ToolError, ToolOutput, parse_input,
    text_file::{LineEndings, resolve_path, write_text_file},
};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::path::Path;
use tracing::debug;

/// Maximum UTF-8 bytes accepted in a single `write` tool call.
///
/// This is intentionally a per-call limit, not a filesystem file-size limit.
/// Larger artifacts should be produced in smaller, reviewable steps rather
/// than passed through one huge tool input.
pub const MAX_WRITE_CONTENT_BYTES: usize = 256 * 1024;

/// Create or overwrite a file.
#[derive(Debug, Default)]
pub struct FileWriteTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FileWriteInput {
    /// Known source encoding for existing text files; auto accepts UTF-8/BOM Unicode.
    /// Use gbk/gb18030 explicitly for Chinese legacy files. New files use this encoding.
    #[serde(default)]
    pub encoding: crate::text_file::TextEncodingHint,
    /// Absolute path, workspace-relative path, or ~/... path to the file to
    /// create or overwrite. Parent directories are created automatically when
    /// allowed.
    pub file_path: String,
    /// Full file content to write. This replaces the entire file. A single
    /// write call accepts at most 256 KiB / 262144 UTF-8 bytes in this field;
    /// prefer an attached targeted-edit capability for small modifications, and
    /// split larger artifacts into smaller steps instead of one huge write.
    pub content: String,
}

#[async_trait]
impl Tool for FileWriteTool {
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon, ToolUiMetadata};
        ToolUiMetadata {
            display_name: "Write file".into(),
            group: ToolUiGroup::Files,
            icon: ToolUiIcon::File,
            description: self.description(),
        }
        .bounded(&self.name())
    }

    fn name(&self) -> String {
        "write".to_string()
    }

    fn description(&self) -> String {
        "Create or overwrite a file at the given path with the provided content. \
         Use this tool when you need to create a new file or replace an existing file. \
         Prefer an attached targeted-edit tool for small changes because it sends a smaller, reviewable diff; \
         use write for new files or deliberate complete rewrites. \
         If the file already exists, read it first; the write is rejected when the file \
         was not read in this session or changed after it was read. \
         Do not create documentation files such as README.md or other *.md files unless the user explicitly requested them. \
         Do not add emojis to files unless the user explicitly requested emojis. \
         Existing files retain the selected source encoding. Specify encoding=gbk or gb18030 for legacy files; unrepresentable text fails before writing. New files default to UTF-8 unless encoding is specified. \
         A single write call supports at most 256 KiB / 262144 UTF-8 bytes of content. \
         For larger files, do not attempt a huge one-shot write; create a smaller scaffold \
         and continue with targeted edits or another incremental generation path."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = crate::clean_schema(schemars::schema_for!(FileWriteInput));
        if let Some(content_schema) = schema
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .and_then(|properties| properties.get_mut("content"))
            .and_then(Value::as_object_mut)
        {
            content_schema.insert(
                "maxLength".to_string(),
                Value::from(MAX_WRITE_CONTENT_BYTES),
            );
        }
        schema
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: FileWriteInput = parse_input(&input)?;
        if input.content.len() > MAX_WRITE_CONTENT_BYTES {
            return Ok(ToolOutput::error(format!(
                "content exceeds write tool limit: {} bytes > {} bytes (256 KiB). \
                 Split the file into smaller, reviewable steps instead of using one huge write call.",
                input.content.len(),
                MAX_WRITE_CONTENT_BYTES
            )));
        }
        let path = resolve_path(&input.file_path, &ctx.state.cwd());

        if let Err(error) = ctx.check_allowed_write_path(&path) {
            return Ok(ToolOutput::error(error));
        }

        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_path(&path, true)
                .map_err(ToolError::Execution)?;
        }

        debug!("writing file {:?}", path);

        let existed_before = path.exists();
        let (old_content, encoding, line_endings) = if path.exists() {
            let metadata = tokio::fs::metadata(&path).await.map_err(|e| {
                ToolError::Execution(format!("failed to stat {}: {}", path.display(), e))
            })?;
            if metadata.is_dir() {
                return Ok(ToolOutput::error(format!(
                    "Cannot write {} because it is a directory, not a file.",
                    path.display()
                )));
            }
            let text_file = crate::text_file::read_text_file_with_encoding(&path, input.encoding).await.map_err(|e| {
                if e.kind() == std::io::ErrorKind::InvalidData {
                    ToolError::Execution(format!(
                        "This tool cannot overwrite binary, unknown-encoding files as text; specify the known encoding explicitly: {} ({e})",
                        path.display()
                    ))
                } else {
                    ToolError::Execution(format!("failed to read {}: {}", path.display(), e))
                }
            })?;
            let encoding = text_file.encoding;
            // Preserve the existing file's line endings on overwrite; forcing
            // LF here silently rewrote every line of CRLF files while `edit`
            // keeps them.
            let line_endings = text_file.line_endings;
            let old_content = text_file.content;
            if let Some(error) = validate_existing_file_was_read(ctx, &path, &old_content) {
                return Ok(ToolOutput::error(error));
            }
            (Some(old_content), encoding, line_endings)
        } else {
            (
                Some(String::new()),
                input.encoding.new_file_encoding(),
                LineEndings::Lf,
            )
        };
        let lsp_baseline = crate::lsp::snapshot_baseline(ctx, &path, old_content.as_deref()).await;

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::Execution(format!("failed to create parent dir: {}", e)))?;
        }

        write_text_file(&path, &input.content, encoding, line_endings)
            .await
            .map_err(|e| {
                ToolError::Execution(format!("failed to write {}: {}", path.display(), e))
            })?;
        ctx.state.record_file_read(
            path.clone(),
            Some(input.content.clone()),
            file_modified_time(&path),
            None,
            None,
        );

        let mut text = if existed_before {
            format!("The file {} has been updated successfully.", path.display())
        } else {
            format!("File created successfully at: {}", path.display())
        };
        if let Some(old_content) = old_content {
            let diff = format_file_diff(&old_content, &input.content);
            if !diff.trim().is_empty() {
                text.push_str(&format!("\n```diff\n{}\n```", diff));
            }
        }
        text = crate::lsp::append_post_write_diagnostics(text, &path, lsp_baseline, &input.content)
            .await;

        Ok(
            ToolOutput::text(text).with_execution_metadata(
                crate::ToolExecutionMetadata::Artifact {
                    path,
                    sha256: format!("{:x}", Sha256::digest(input.content.as_bytes())),
                },
            ),
        )
    }
}

fn format_file_diff(old_text: &str, new_text: &str) -> String {
    let diff = TextDiff::from_lines(old_text, new_text);
    diff.unified_diff().context_radius(3).to_string()
}

fn validate_existing_file_was_read(
    ctx: &ToolContext,
    path: &Path,
    current_content: &str,
) -> Option<String> {
    let Some(snapshot) = ctx.state.file_read_snapshot(path) else {
        return Some(format!(
            "File has not been read this session. Read it before attempting to write: {}",
            path.display()
        ));
    };

    let current_modified = file_modified_time(path);
    if file_modified_after_snapshot(snapshot.modified, current_modified) {
        let content_unchanged =
            snapshot.is_full_read() && snapshot.content.as_deref() == Some(current_content);
        if !content_unchanged {
            return Some(
                "File has been unexpectedly modified. Read it again before attempting to write."
                    .to_string(),
            );
        }
    }

    None
}

fn file_modified_after_snapshot(
    snapshot_modified: Option<std::time::SystemTime>,
    current_modified: Option<std::time::SystemTime>,
) -> bool {
    match (snapshot_modified, current_modified) {
        (Some(snapshot_modified), Some(current_modified)) => current_modified > snapshot_modified,
        _ => false,
    }
}

fn file_modified_time(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use serde_json::json;

    #[tokio::test]
    async fn overwrite_preserves_existing_crlf_line_endings() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("windows.txt");
        std::fs::write(&path, b"old\r\ncontent\r\n").unwrap();
        let state = AppState::new(tmp.path());
        state.record_file_read(
            path.clone(),
            Some("old\ncontent\n".to_string()),
            file_modified_time(&path),
            None,
            None,
        );
        let ctx = ToolContext::new(state);

        let output = FileWriteTool
            .call(
                json!({"file_path": path, "content": "new\ncontent\n"}),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!output.is_error);
        assert_eq!(std::fs::read(&path).unwrap(), b"new\r\ncontent\r\n");
    }
}
