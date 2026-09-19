use crate::{
    Tool, ToolContext, ToolError, ToolOutput, parse_input,
    text_file::{read_text_file, resolve_path},
};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use kcoder_state::ReadRangeKey;
use kcoder_types::{ContentBlock, ImageSource};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tracing::debug;

/// Read the contents of a file, or a slice of it.
#[derive(Debug, Default)]
pub struct FileReadTool;

const FILE_UNCHANGED_STUB: &str = "File unchanged since last read. The content from the earlier read tool_result in this conversation is still current; refer to that instead of re-reading.";
const MAX_COMPACTION_READ_ANCHOR_BYTES: usize = 959;
const MAX_IMAGE_READ_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_MAX_LINES_TO_READ: usize = 2000;
const THIN_SPACE: char = '\u{202f}';

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FileReadInput {
    /// Absolute path, workspace-relative path, or ~/... path to the file.
    /// Directories are not accepted; use search/list tooling for directories.
    pub file_path: String,
    /// Optional 1-based line number to start reading from. Omit to start at
    /// the beginning of the file.
    pub offset: Option<usize>,
    /// Optional maximum number of lines to read. Use a JSON integer; omit to
    /// read the default 2000-line range from the offset.
    pub limit: Option<usize>,
    /// Optional page range for PDF files, e.g. "1-5". PDF extraction is not
    /// implemented in this Rust tool yet; unsupported values return an
    /// explicit error instead of silently reading binary data.
    pub pages: Option<String>,
}

#[async_trait]
impl Tool for FileReadTool {
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon, ToolUiMetadata};
        ToolUiMetadata {
            display_name: "Read file".into(),
            group: ToolUiGroup::Files,
            icon: ToolUiIcon::File,
            description: self.description(),
        }
        .bounded(&self.name())
    }

    fn name(&self) -> String {
        "read".to_string()
    }

    fn description(&self) -> String {
        "Read the contents of a file at the given path. \
         By default, reads up to 2000 lines from the beginning of a text file. \
         Optionally specify a 1-indexed offset and a line limit for targeted reads. \
         Supports UTF-8 and UTF-16LE text files, common image files (PNG/JPG/GIF/WebP), \
         and Jupyter notebooks. CRLF text is shown with normalized line endings so \
         edit old_string values can use the text shown by Read. If the user provides a screenshot \
         path, use this tool to view it. Directories and binary files are rejected."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(FileReadInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: FileReadInput = parse_input(&input)?;
        let path = normalize_lexical_path(&resolve_path(&input.file_path, &ctx.state.cwd()));

        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_path(&path, false)
                .map_err(ToolError::Execution)?;
        }

        debug!("reading file {:?}", path);

        if is_blocked_device_path(&path) {
            return Ok(ToolOutput::error(format!(
                "Cannot read '{}': this device file would block or produce infinite output.",
                input.file_path
            )));
        }

        let path = if path.exists() {
            path
        } else if let Some(alternate) = alternate_screenshot_path(&path) {
            if let Some(sandbox) = &ctx.sandbox {
                sandbox
                    .check_path(&alternate, false)
                    .map_err(ToolError::Execution)?;
            }
            alternate
        } else {
            return Ok(ToolOutput::error(missing_file_message(
                &path,
                &ctx.state.cwd(),
            )));
        };

        if path.is_dir() {
            return Ok(ToolOutput::error(format!(
                "{} is a directory, not a file",
                path.display()
            )));
        }

        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .unwrap_or_default();

        if ext == "pdf" {
            return Ok(ToolOutput::error(match input.pages {
                Some(pages) => format!(
                    "PDF page reading is not implemented in this Rust tool yet (requested pages: {pages})."
                ),
                None => "PDF reading is not implemented in this Rust tool yet. Use a shell/PDF utility or provide a text export.".to_string(),
            }));
        }

        if let Some(media_type) = image_media_type(&ext) {
            return read_image(&path, media_type).await;
        }

        if has_binary_extension(&ext) {
            return Ok(ToolOutput::error(format!(
                "This tool cannot read binary files. The file appears to be a binary .{} file. Please use an appropriate binary analysis tool.",
                ext
            )));
        }

        let snapshot_offset = input.offset;
        let snapshot_limit = input.limit;
        let snapshot_range = ReadRangeKey::new(snapshot_offset, snapshot_limit);
        if let Some(tool_call_id) = ctx.tool_call_id.as_deref() {
            ctx.state.record_read_tool_call_key(
                tool_call_id,
                path.clone(),
                snapshot_offset,
                snapshot_limit,
            );
        }
        let previous_snapshot =
            ctx.state
                .file_read_snapshot_for_request(&path, snapshot_offset, snapshot_limit);
        let compacted_full_snapshot = ctx.state.full_file_read_snapshot(&path);
        let explicit_range_may_cover_compacted_body = !snapshot_range.is_full()
            && input.offset.unwrap_or(1) <= 1
            && compacted_full_snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.anchor_pending || snapshot.full_body_compacted);
        if let Some(snapshot) = previous_snapshot.as_ref()
            && snapshot.from_read_tool
            && ReadRangeKey::new(snapshot.offset, snapshot.limit) == snapshot_range
            && snapshot.modified == file_modified_time(&path)
            && !explicit_range_may_cover_compacted_body
        {
            return Ok(ToolOutput::text(FILE_UNCHANGED_STUB));
        }

        if ext == "ipynb" {
            return read_notebook(&path, &input, ctx).await;
        }

        // Reject pathologically large text files before slurping them: the
        // tool reads the whole file into memory before slicing lines, so a
        // multi-GB file would take down the process. Point the model at
        // bounded alternatives instead.
        const MAX_TEXT_READ_BYTES: u64 = 100 * 1024 * 1024;
        if let Ok(metadata) = std::fs::metadata(&path)
            && metadata.len() > MAX_TEXT_READ_BYTES
        {
            return Ok(ToolOutput::error(format!(
                "Cannot read '{}': file is {} bytes, over the {} byte limit. Use grep to search within it, or bash with head/tail/sed to view a portion.",
                path.display(),
                metadata.len(),
                MAX_TEXT_READ_BYTES
            )));
        }

        let text_file = read_text_file(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidData {
                ToolError::Execution(format!(
                    "This tool cannot read binary, non-UTF-8, or non-UTF-16LE files as text: {}",
                    path.display()
                ))
            } else {
                ToolError::Execution(format!("failed to read {}: {}", path.display(), e))
            }
        })?;
        let content = text_file.content;
        let modified = file_modified_time(&path);
        let covers_entire_file = read_request_covers_entire_content(&input, &content);
        if let Some(snapshot) = compacted_full_snapshot.as_ref()
            && (snapshot.anchor_pending || snapshot.full_body_compacted)
            && covers_entire_file
            && snapshot.modified == modified
            && snapshot.content.as_deref() == Some(content.as_str())
        {
            // An identical full read after compaction returns a stable small anchor. It
            // retains enough location information while remaining below the 1K
            // micro-compaction cleanup threshold, preventing another large-file loop.
            record_text_read_snapshot(
                ctx,
                &path,
                &content,
                modified,
                &input,
                covers_entire_file,
                true,
            );
            return Ok(ToolOutput::text(build_compaction_read_anchor(
                &path, &content,
            )));
        }
        record_text_read_snapshot(
            ctx,
            &path,
            &content,
            modified,
            &input,
            covers_entire_file,
            false,
        );

        let lines: Vec<&str> = content.lines().collect();
        let offset = input.offset.unwrap_or(1).saturating_sub(1);
        let limit = input
            .limit
            .unwrap_or(DEFAULT_MAX_LINES_TO_READ)
            .min(lines.len().saturating_sub(offset));

        let selected: Vec<&str> = lines.iter().skip(offset).take(limit).copied().collect();
        let result = format_numbered_lines(&selected, offset + 1);

        // Cap the produced text. Even though the caller may pass `limit`, a
        // single very long line can blow past the byte budget and freeze the
        // TUI on the next render. Truncating here keeps the output bounded
        // regardless of how the model invokes the tool.
        let result = ctx.truncate(&result);

        if content.is_empty() {
            Ok(ToolOutput::text(format!(
                "<system-reminder>Warning: {} exists but the contents are empty.</system-reminder>",
                path.display()
            )))
        } else if selected.is_empty() && offset >= lines.len() {
            Ok(ToolOutput::text(format!(
                "<system-reminder>Warning: {} is shorter than the provided offset ({}). The file has {} lines.</system-reminder>",
                path.display(),
                offset + 1,
                lines.len()
            )))
        } else if selected.len() < lines.len() || input.offset.is_some() || input.limit.is_some() {
            Ok(ToolOutput::text(format!(
                "Showing lines {}-{} of {} from {}:\n\n{}",
                offset + 1,
                offset + selected.len(),
                lines.len(),
                path.display(),
                result
            )))
        } else {
            Ok(ToolOutput::text(format!(
                "Contents of {}:\n\n{}",
                path.display(),
                result
            )))
        }
    }
}

fn file_modified_time(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

fn read_request_covers_entire_content(input: &FileReadInput, content: &str) -> bool {
    if input.offset.unwrap_or(1) > 1 {
        return false;
    }
    input
        .limit
        .is_none_or(|limit| limit >= content.lines().count())
}

fn record_text_read_snapshot(
    ctx: &ToolContext,
    path: &Path,
    content: &str,
    modified: Option<std::time::SystemTime>,
    input: &FileReadInput,
    covers_entire_file: bool,
    returned_anchor: bool,
) {
    let requested_range = ReadRangeKey::new(input.offset, input.limit);
    if covers_entire_file {
        // Although this request may include offset/limit, it observed the complete
        // file. Update the independent full snapshot first. If the response is an
        // anchor, state retains a durable full_body_compacted marker and clears it when body content changes.
        ctx.state.record_read_tool_snapshot(
            path.to_path_buf(),
            Some(content.to_string()),
            modified,
            None,
            None,
        );
        if !requested_range.is_full() {
            ctx.state.record_read_tool_snapshot(
                path.to_path_buf(),
                (!returned_anchor).then(|| content.to_string()),
                modified,
                input.offset,
                input.limit,
            );
            // Compaction must map a result that actually spans the complete body back to
            // the full snapshot; otherwise clearing an explicit range body would not restore anchor-only state.
            if let Some(tool_call_id) = ctx.tool_call_id.as_deref() {
                ctx.state
                    .record_read_tool_call_key(tool_call_id, path.to_path_buf(), None, None);
            }
        }
    } else {
        ctx.state.record_read_tool_snapshot(
            path.to_path_buf(),
            None,
            modified,
            input.offset,
            input.limit,
        );
    }
}

fn normalize_lexical_path(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn build_compaction_read_anchor(path: &Path, content: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
    let lines = content.lines().collect::<Vec<_>>();
    let path = truncate_utf8_bytes(&path.display().to_string(), 180);
    let footer = "\nUse read with offset and limit to inspect the exact region needed; a changed file will return fresh content.";
    let mut output = format!(
        "Compaction read anchor (unchanged file)\nPath: {path}\nSHA-256: {}\nLines: {}\nCached excerpts:",
        &digest[..16],
        lines.len()
    );
    let excerpt_budget = MAX_COMPACTION_READ_ANCHOR_BYTES
        .saturating_sub(output.len())
        .saturating_sub(footer.len());
    let mut excerpts = String::new();
    let mut seen = HashSet::new();

    let mut candidates = Vec::new();
    for index in 0..lines.len().min(2) {
        candidates.push((index, "head"));
    }
    for index in lines.len().saturating_sub(2)..lines.len() {
        candidates.push((index, "tail"));
    }
    for (index, line) in lines.iter().enumerate() {
        if is_source_declaration(line) {
            candidates.push((index, "decl"));
        }
    }

    for (index, kind) in candidates {
        if !seen.insert(index) {
            continue;
        }
        let line = truncate_utf8_bytes(lines[index].trim_end(), 88);
        let candidate = format!("\n{kind} L{}: {line}", index + 1);
        if excerpts.len().saturating_add(candidate.len()) > excerpt_budget {
            continue;
        }
        excerpts.push_str(&candidate);
    }
    if excerpts.is_empty() {
        excerpts.push_str("\n(no excerpt fits; use a bounded line range)");
    }
    output.push_str(&excerpts);
    output.push_str(footer);
    debug_assert!(output.len() <= MAX_COMPACTION_READ_ANCHOR_BYTES);
    output
}

fn is_source_declaration(line: &str) -> bool {
    let line = line.trim_start();
    [
        "def ",
        "async def ",
        "class ",
        "fn ",
        "pub fn ",
        "struct ",
        "pub struct ",
        "enum ",
        "pub enum ",
        "trait ",
        "impl ",
        "function ",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes.saturating_sub(3).min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

async fn read_image(path: &Path, media_type: &str) -> Result<ToolOutput, ToolError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| ToolError::Execution(format!("failed to stat {}: {}", path.display(), e)))?;
    if metadata.len() == 0 {
        return Ok(ToolOutput::error(format!(
            "Image file is empty: {}",
            path.display()
        )));
    }
    if metadata.len() > MAX_IMAGE_READ_BYTES {
        return Ok(ToolOutput::error(format!(
            "Image file is larger than {} MB: {}",
            MAX_IMAGE_READ_BYTES / 1024 / 1024,
            path.display()
        )));
    }

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| ToolError::Execution(format!("failed to read {}: {}", path.display(), e)))?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(ToolOutput {
        content: vec![
            ContentBlock::Text {
                text: format!(
                    "Read image {} ({} bytes, {}).",
                    path.display(),
                    bytes.len(),
                    media_type
                ),
            },
            ContentBlock::Image {
                source: ImageSource::base64(media_type, BASE64_STANDARD.encode(bytes)),
            },
        ],
        is_error: false,
        execution_metadata: vec![crate::ToolExecutionMetadata::Artifact {
            path: path.to_path_buf(),
            sha256,
        }],
        user_context: Vec::new(),
    })
}

async fn read_notebook(
    path: &Path,
    input: &FileReadInput,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let raw = tokio::fs::read_to_string(path).await.map_err(|e| {
        ToolError::Execution(format!("failed to read notebook {}: {}", path.display(), e))
    })?;
    let modified = file_modified_time(path);
    let covers_entire_file = read_request_covers_entire_content(input, &raw);
    if let Some(snapshot) = ctx.state.full_file_read_snapshot(path)
        && (snapshot.anchor_pending || snapshot.full_body_compacted)
        && covers_entire_file
        && snapshot.modified == modified
        && snapshot.content.as_deref() == Some(raw.as_str())
    {
        record_text_read_snapshot(ctx, path, &raw, modified, input, covers_entire_file, true);
        return Ok(ToolOutput::text(build_compaction_read_anchor(path, &raw)));
    }
    let notebook: Value = serde_json::from_str(&raw)
        .map_err(|e| ToolError::Execution(format!("invalid notebook JSON: {}", e)))?;
    let rendered = render_notebook(&notebook, path);
    record_text_read_snapshot(ctx, path, &raw, modified, input, covers_entire_file, false);
    Ok(ToolOutput::text(ctx.truncate(&rendered)))
}

fn render_notebook(notebook: &Value, path: &Path) -> String {
    let mut out = format!("Notebook: {}\n", path.display());
    let Some(cells) = notebook.get("cells").and_then(|cells| cells.as_array()) else {
        out.push_str("No cells found.");
        return out;
    };

    for (index, cell) in cells.iter().enumerate() {
        let cell_type = cell
            .get("cell_type")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        out.push_str(&format!("\nCell {} [{}]\n", index + 1, cell_type));
        let source = notebook_string(cell.get("source"));
        if source.trim().is_empty() {
            out.push_str("<empty>\n");
        } else {
            out.push_str(source.trim_end());
            out.push('\n');
        }

        if let Some(outputs) = cell.get("outputs").and_then(|outputs| outputs.as_array()) {
            let mut rendered_outputs = Vec::new();
            for output in outputs {
                if let Some(text) = output.get("text") {
                    rendered_outputs.push(notebook_string(Some(text)));
                } else if let Some(data) = output.get("data")
                    && let Some(text) = data.get("text/plain")
                {
                    rendered_outputs.push(notebook_string(Some(text)));
                }
            }
            if !rendered_outputs.is_empty() {
                out.push_str("Outputs:\n");
                out.push_str(rendered_outputs.join("\n").trim_end());
                out.push('\n');
            }
        }
    }

    out
}

fn notebook_string(value: Option<&Value>) -> Cow<'_, str> {
    match value {
        Some(Value::String(text)) => Cow::Borrowed(text),
        Some(Value::Array(parts)) => Cow::Owned(
            parts
                .iter()
                .filter_map(|part| part.as_str())
                .collect::<Vec<_>>()
                .join(""),
        ),
        Some(other) => Cow::Owned(other.to_string()),
        None => Cow::Borrowed(""),
    }
}

fn format_numbered_lines(lines: &[&str], start_line: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{}", start_line + index, line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn image_media_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn has_binary_extension(ext: &str) -> bool {
    matches!(
        ext,
        "7z" | "a"
            | "app"
            | "bin"
            | "bmp"
            | "class"
            | "db"
            | "dmg"
            | "doc"
            | "docx"
            | "dylib"
            | "exe"
            | "ico"
            | "jar"
            | "jpeg2000"
            | "jpg2"
            | "lib"
            | "o"
            | "obj"
            | "odt"
            | "otf"
            | "pkl"
            | "ppt"
            | "pptx"
            | "pyc"
            | "rar"
            | "so"
            | "sqlite"
            | "tar"
            | "ttf"
            | "wasm"
            | "woff"
            | "woff2"
            | "xls"
            | "xlsx"
            | "zip"
    )
}

fn is_blocked_device_path(path: &Path) -> bool {
    if is_blocked_device_name(&path.to_string_lossy()) {
        return true;
    }
    // Resolve aliases: `/dev/./zero` and symlinks must not bypass the
    // exact-name blocklist.
    if let Ok(canonical) = path.canonicalize()
        && canonical != path
        && is_blocked_device_name(&canonical.to_string_lossy())
    {
        return true;
    }
    // Any character/block device or FIFO would block or stream forever; the
    // name list above is only documentation of the most common offenders.
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            let file_type = metadata.file_type();
            if file_type.is_char_device() || file_type.is_block_device() || file_type.is_fifo() {
                return true;
            }
        }
    }
    false
}

fn is_blocked_device_name(text: &str) -> bool {
    matches!(
        text,
        "/dev/zero"
            | "/dev/random"
            | "/dev/urandom"
            | "/dev/full"
            | "/dev/stdin"
            | "/dev/tty"
            | "/dev/console"
            | "/dev/stdout"
            | "/dev/stderr"
            | "/dev/fd/0"
            | "/dev/fd/1"
            | "/dev/fd/2"
    ) || (text.starts_with("/proc/")
        && (text.ends_with("/fd/0") || text.ends_with("/fd/1") || text.ends_with("/fd/2")))
}

fn alternate_screenshot_path(path: &Path) -> Option<PathBuf> {
    let filename = path.file_name()?.to_str()?;
    let parent = path.parent()?;
    for meridiem in ["AM", "PM"] {
        let regular_suffix = format!(" {meridiem}.png");
        if let Some(prefix) = filename.strip_suffix(&regular_suffix) {
            let alternate = parent.join(format!("{prefix}{THIN_SPACE}{meridiem}.png"));
            if alternate.exists() {
                return Some(alternate);
            }
        }

        let thin_suffix = format!("{THIN_SPACE}{meridiem}.png");
        if let Some(prefix) = filename.strip_suffix(&thin_suffix) {
            let alternate = parent.join(format!("{prefix} {meridiem}.png"));
            if alternate.exists() {
                return Some(alternate);
            }
        }
    }
    None
}

fn missing_file_message(path: &Path, cwd: &Path) -> String {
    let mut message = format!(
        "File does not exist: {}. Current working directory: {}.",
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
