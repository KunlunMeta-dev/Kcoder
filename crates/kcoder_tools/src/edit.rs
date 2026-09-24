use crate::{
    Tool, ToolContext, ToolError, ToolOutput, parse_input,
    text_file::{LineEndings, resolve_path, write_text_file},
};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, de::Error as DeError};
use serde_json::Value;
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::path::{Path, PathBuf};
use tracing::debug;

/// Replace an exact string in a file.
#[derive(Debug, Default)]
pub struct FileEditTool;

/// Maximum existing file size accepted by the edit tool.
pub const MAX_EDIT_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FileEditInput {
    /// Known source encoding for existing text files; auto accepts UTF-8/BOM Unicode.
    /// Use gbk/gb18030 explicitly for Chinese legacy files. New files use this encoding.
    #[serde(default)]
    pub encoding: crate::text_file::TextEncodingHint,
    /// Absolute path, workspace-relative path, or ~/... path to the existing
    /// file to modify.
    pub file_path: String,
    /// Exact existing text to find. Preserve whitespace, indentation, and line
    /// endings as shown by Read. Read the target file or relevant line range
    /// first and copy this from the current content; the edit fails when this
    /// string is not found.
    pub old_string: String,
    /// Replacement text. Use an empty string only when deleting the matched
    /// text.
    pub new_string: String,
    /// JSON boolean. Set true to replace every occurrence; omit or false to
    /// replace a single occurrence.
    #[serde(default, deserialize_with = "deserialize_boolish")]
    pub replace_all: bool,
}

#[async_trait]
impl Tool for FileEditTool {
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon, ToolUiMetadata};
        ToolUiMetadata {
            display_name: "Edit file".into(),
            group: ToolUiGroup::Files,
            icon: ToolUiIcon::File,
            description: self.description(),
        }
        .bounded(&self.name())
    }

    fn name(&self) -> String {
        "edit".to_string()
    }

    fn description(&self) -> String {
        "Make an exact-string replacement in an existing file. \
         Use this tool whenever you need to modify part of a file. \
         Prefer targeted edits over complete file replacement. \
         Before calling edit, read the target file first, or at least read the relevant line range, \
         so old_string is copied from the current file contents with exact whitespace and indentation. \
         When copying from Read output, do not include the line number prefix in old_string or new_string; \
         only include the actual file content after the prefix. \
         UTF-8, UTF-16LE and explicit gbk/gb18030 are supported; use the same known encoding as read, never guess. Unrepresentable writes fail before modifying the file; CRLF files can be matched with the LF-normalized text shown by Read and are written back with their original line ending style. \
         The edit fails if old_string is not unique unless replace_all is true. \
         Use replace_all for deliberate renames or whole-file string replacements. \
         Do not add emojis to files unless the user explicitly requested emojis. \
         Prefer an attached file-creation tool for new files. Legacy empty old_string creation is accepted only for missing or empty files."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(FileEditInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: FileEditInput = parse_input(&input)?;
        let path = resolve_path(&input.file_path, &ctx.state.cwd());

        if let Err(error) = ctx.check_allowed_write_path(&path) {
            return Ok(ToolOutput::error(error));
        }

        if input.old_string == input.new_string {
            return Ok(ToolOutput::error(
                "No changes to make: old_string and new_string are exactly the same.",
            ));
        }

        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_path(&path, true)
                .map_err(ToolError::Execution)?;
        }

        debug!("editing file {:?}", path);

        if !path.exists() {
            if input.old_string.is_empty() {
                let lsp_baseline = crate::lsp::snapshot_baseline(ctx, &path, Some("")).await;
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|e| {
                        ToolError::Execution(format!("failed to create parent dir: {}", e))
                    })?;
                }
                write_text_file(
                    &path,
                    &input.new_string,
                    input.encoding.new_file_encoding(),
                    LineEndings::Lf,
                )
                .await
                .map_err(|e| {
                    ToolError::Execution(format!("failed to write {}: {}", path.display(), e))
                })?;
                ctx.state.record_file_read(
                    path.clone(),
                    Some(input.new_string.clone()),
                    file_modified_time(&path),
                    None,
                    None,
                );
                let diff = format_file_diff("", &input.new_string);
                let text = format!("Edited {}\n```diff\n{}\n```", path.display(), diff);
                let text = crate::lsp::append_post_write_diagnostics(
                    text,
                    &path,
                    lsp_baseline,
                    &input.new_string,
                )
                .await;
                return Ok(ToolOutput::text(text));
            }
            return Ok(ToolOutput::error(missing_file_message(
                &path,
                &ctx.state.cwd(),
            )));
        }

        let metadata = tokio::fs::metadata(&path).await.map_err(|e| {
            ToolError::Execution(format!("failed to stat {}: {}", path.display(), e))
        })?;
        if metadata.is_dir() {
            return Ok(ToolOutput::error(format!(
                "Cannot edit {} because it is a directory, not a file.",
                path.display()
            )));
        }
        if metadata.len() > MAX_EDIT_FILE_SIZE_BYTES {
            return Ok(ToolOutput::error(format!(
                "File is too large to edit ({}). Maximum editable file size is {}.",
                format_size(metadata.len()),
                format_size(MAX_EDIT_FILE_SIZE_BYTES)
            )));
        }

        if path.extension().and_then(|ext| ext.to_str()) == Some("ipynb") {
            return Ok(ToolOutput::error(
                "File is a Jupyter Notebook. Use notebook_edit to edit this file.",
            ));
        }

        let text_file = crate::text_file::read_text_file_with_encoding(&path, input.encoding).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidData {
                ToolError::Execution(format!(
                    "This tool cannot edit binary, unknown-encoding files as text; specify the known encoding explicitly: {} ({e})",
                    path.display()
                ))
            } else {
                ToolError::Execution(format!("failed to read {}: {}", path.display(), e))
            }
        })?;
        let encoding = text_file.encoding;
        let line_endings = text_file.line_endings;
        let content = text_file.content;

        if input.old_string.is_empty() {
            if !content.trim().is_empty() {
                return Ok(ToolOutput::error(
                    "Cannot create new file - file already exists.",
                ));
            }
            let lsp_baseline = crate::lsp::snapshot_baseline(ctx, &path, Some(&content)).await;
            write_text_file(&path, &input.new_string, encoding, line_endings)
                .await
                .map_err(|e| {
                    ToolError::Execution(format!("failed to write {}: {}", path.display(), e))
                })?;
            ctx.state.record_file_read(
                path.clone(),
                Some(input.new_string.clone()),
                file_modified_time(&path),
                None,
                None,
            );
            let diff = format_file_diff(&content, &input.new_string);
            let text = format!("Edited {}\n```diff\n{}\n```", path.display(), diff);
            let text = crate::lsp::append_post_write_diagnostics(
                text,
                &path,
                lsp_baseline,
                &input.new_string,
            )
            .await;
            return Ok(ToolOutput::text(text));
        }

        if let Some(error) = validate_existing_file_was_read(ctx, &path, &content) {
            return Ok(ToolOutput::error(error));
        }
        let lsp_baseline = crate::lsp::snapshot_baseline(ctx, &path, Some(&content)).await;

        let normalized_new_string = normalize_replacement_for_path(&path, &input.new_string);
        let (actual_old_string, new_string) =
            match find_actual_edit_strings(&content, &input.old_string, &normalized_new_string) {
                Some(match_pair) => match_pair,
                None => {
                    return Ok(ToolOutput::error(format!(
                        "old_string not found in file: {}",
                        path.display()
                    )));
                }
            };

        if actual_old_string == new_string {
            return Ok(ToolOutput::error(
                "No changes to make: old_string and new_string are exactly the same after input normalization.",
            ));
        }

        let matches = content.matches(&actual_old_string).count();
        if matches > 1 && !input.replace_all {
            return Ok(ToolOutput::error(format!(
                "Found {matches} matches of old_string, but replace_all is false. \
                 To replace all occurrences, set replace_all to true. To replace only one occurrence, \
                 provide more surrounding context so old_string is unique."
            )));
        }

        let new_content = if input.replace_all {
            content.replace(&actual_old_string, &new_string)
        } else {
            apply_single_edit(&content, &actual_old_string, &new_string)
        };

        write_text_file(&path, &new_content, encoding, line_endings)
            .await
            .map_err(|e| {
                ToolError::Execution(format!("failed to write {}: {}", path.display(), e))
            })?;
        ctx.state.record_file_read(
            path.clone(),
            Some(new_content.clone()),
            file_modified_time(&path),
            None,
            None,
        );

        let diff = format_file_diff(&content, &new_content);
        let text = format!("Edited {}\n```diff\n{}\n```", path.display(), diff);
        let text =
            crate::lsp::append_post_write_diagnostics(text, &path, lsp_baseline, &new_content)
                .await;
        Ok(
            ToolOutput::text(text).with_execution_metadata(
                crate::ToolExecutionMetadata::Artifact {
                    path,
                    sha256: format!("{:x}", Sha256::digest(new_content.as_bytes())),
                },
            ),
        )
    }
}

pub(crate) fn format_file_diff(old_text: &str, new_text: &str) -> String {
    let diff = TextDiff::from_lines(old_text, new_text);
    diff.unified_diff().context_radius(3).to_string()
}

fn apply_single_edit(content: &str, old_string: &str, new_string: &str) -> String {
    if new_string.is_empty()
        && !old_string.ends_with('\n')
        && content.contains(&format!("{old_string}\n"))
    {
        return content.replacen(&format!("{old_string}\n"), new_string, 1);
    }
    content.replacen(old_string, new_string, 1)
}

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(value),
        Some(Value::String(value)) => match value.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            other => Err(D::Error::custom(format!(
                "replace_all must be a boolean or the string \"true\"/\"false\", got {other:?}"
            ))),
        },
        Some(other) => Err(D::Error::custom(format!(
            "replace_all must be a boolean, got {other}"
        ))),
    }
}

fn find_actual_edit_strings(
    file_content: &str,
    old_string: &str,
    new_string: &str,
) -> Option<(String, String)> {
    if file_content.contains(old_string) {
        return Some((old_string.to_string(), new_string.to_string()));
    }

    let (desanitized_old_string, replacements) = desanitize_match_string(old_string);
    if file_content.contains(&desanitized_old_string) {
        let mut desanitized_new_string = new_string.to_string();
        for (from, to) in replacements {
            desanitized_new_string = desanitized_new_string.replace(from, to);
        }
        return Some((desanitized_old_string, desanitized_new_string));
    }

    None
}

const DESANITIZATIONS: &[(&str, &str)] = &[
    ("<fnr>", "<function_results>"),
    ("<n>", "<name>"),
    ("</n>", "</name>"),
    ("<o>", "<output>"),
    ("</o>", "</output>"),
    ("<e>", "<error>"),
    ("</e>", "</error>"),
    ("<s>", "<system>"),
    ("</s>", "</system>"),
    ("<r>", "<result>"),
    ("</r>", "</result>"),
    ("< META_START >", "<META_START>"),
    ("< META_END >", "<META_END>"),
    ("< EOT >", "<EOT>"),
    ("< META >", "<META>"),
    ("< SOS >", "<SOS>"),
    ("\n\nH:", "\n\nHuman:"),
    ("\n\nA:", "\n\nAssistant:"),
];

fn desanitize_match_string(match_string: &str) -> (String, Vec<(&'static str, &'static str)>) {
    let mut result = match_string.to_string();
    let mut applied = Vec::new();

    for &(from, to) in DESANITIZATIONS {
        let before = result.clone();
        result = result.replace(from, to);
        if before != result {
            applied.push((from, to));
        }
    }

    (result, applied)
}

fn normalize_replacement_for_path(path: &Path, new_string: &str) -> String {
    if is_markdown(path) {
        new_string.to_string()
    } else {
        strip_trailing_whitespace_preserving_line_endings(new_string)
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "mdx"))
}

fn strip_trailing_whitespace_preserving_line_endings(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(newline_index) = rest.find('\n') {
        let mut line = &rest[..newline_index];
        let line_ending = if let Some(stripped) = line.strip_suffix('\r') {
            line = stripped;
            "\r\n"
        } else {
            "\n"
        };
        output.push_str(line.trim_end_matches(char::is_whitespace));
        output.push_str(line_ending);
        rest = &rest[newline_index + 1..];
    }

    output.push_str(rest.trim_end_matches(char::is_whitespace));
    output
}

fn missing_file_message(path: &Path, cwd: &Path) -> String {
    let mut message = format!(
        "File not found: {}. Current working directory: {}.",
        path.display(),
        cwd.display()
    );
    if let Some(corrected) = suggest_path_under_cwd(path, cwd) {
        message.push_str(&format!(" Did you mean {}?", corrected.display()));
    } else if let Some(similar) = find_similar_file(path) {
        message.push_str(&format!(" Did you mean {}?", similar.display()));
    }
    message
}

fn suggest_path_under_cwd(path: &Path, cwd: &Path) -> Option<PathBuf> {
    let cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let cwd_parent = cwd.parent()?;
    let file_name = path.file_name()?;
    let resolved_path = path
        .parent()
        .and_then(|parent| dunce::canonicalize(parent).ok())
        .map(|resolved_parent| resolved_parent.join(file_name))
        .unwrap_or_else(|| path.to_path_buf());

    if !crate::sandbox::path_starts_with(&resolved_path, cwd_parent)
        || crate::sandbox::path_starts_with(&resolved_path, &cwd)
        || resolved_path == cwd
    {
        return None;
    }

    let rel_from_parent = crate::sandbox::path_strip_prefix(&resolved_path, cwd_parent)?;
    let corrected_path = cwd.join(rel_from_parent);
    corrected_path.exists().then_some(corrected_path)
}

fn find_similar_file(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let target_name = path.file_name()?.to_str()?;
    let target_stem = path.file_stem()?.to_str()?;
    let mut candidates = std::fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| entry.path())
        })
        .filter(|candidate| {
            let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
                return false;
            };
            if name.eq_ignore_ascii_case(target_name) {
                return true;
            }
            candidate
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|stem| stem == target_stem)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

fn format_size(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = KIB * 1024;
    const GIB: u64 = MIB * 1024;

    if bytes >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} bytes")
    }
}

fn validate_existing_file_was_read(
    ctx: &ToolContext,
    path: &Path,
    current_content: &str,
) -> Option<String> {
    let Some(snapshot) = ctx.state.file_read_snapshot(path) else {
        return Some(format!(
            "File has not been read this session. Read it before attempting to edit: {}",
            path.display()
        ));
    };

    let current_modified = file_modified_time(path);
    if file_modified_after_snapshot(snapshot.modified, current_modified) {
        let content_unchanged =
            snapshot.is_full_read() && snapshot.content.as_deref() == Some(current_content);
        if !content_unchanged {
            return Some(
                "File has been unexpectedly modified. Read it again before attempting to edit."
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

pub(crate) fn file_modified_time(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}
