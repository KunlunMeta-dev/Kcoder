use super::apply::apply_chunks;
use super::parser::{Hunk, parse_patch};
use crate::edit::{file_modified_time, format_file_diff};
use crate::text_file::{LineEndings, TextEncoding, read_text_file, resolve_path, write_text_file};
use crate::{Tool, ToolContext, ToolError, ToolExecutionMetadata, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Codex-style multi-file patch tool.
#[derive(Debug, Default)]
pub struct ApplyPatchTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ApplyPatchInput {
    /// The full patch text, including the `*** Begin Patch` / `*** End Patch`
    /// envelope. Do not include line numbers or heredoc markers.
    pub patch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug)]
struct StagedChange {
    path: PathBuf,
    moved_from: Option<PathBuf>,
    kind: ChangeKind,
    encoding: TextEncoding,
    line_endings: LineEndings,
    old_text: String,
    new_text: String,
}

fn verification_error(error: impl Into<String>) -> ToolOutput {
    ToolOutput::error(format!("apply_patch verification failed: {}", error.into()))
}

#[async_trait]
impl Tool for ApplyPatchTool {
    fn name(&self) -> String {
        "apply_patch".to_string()
    }

    fn description(&self) -> String {
        "Apply a codex-style multi-file patch: ONE JSON object with a single `patch` \
         string. Format: first line `*** Begin Patch`, last line `*** End Patch`, one or \
         more hunks between them. Hunk kinds: `*** Add File: <path>` followed ONLY by \
         `+content` lines; `*** Delete File: <path>`; `*** Update File: <path>` with an \
         optional `*** Move to: <path>` line followed by change chunks. A chunk starts at \
         an `@@ <text anchor>` line (anchor = any distinctive line near the edit; bare `@@` \
         allowed), then `-removed` lines, `+added` lines, and ` ` space-prefixed context \
         lines; context/removed lines must exist in the file (matching tolerates whitespace \
         differences only). `*** End of File` pins a chunk to the file end and empty-removal \
         chunks then insert there. Chunks MUST be written in top-to-bottom file order; the \
         search cursor never moves backwards. Paths may be workspace-relative or absolute. \
         Prefer this over edit when one turn changes several files: all hunks across all \
         files are verified against on-disk content BEFORE the first write, so a failing \
         hunk leaves the workspace untouched for this call. Unlike edit, no prior `read` is \
         required."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(ApplyPatchInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ApplyPatchInput = parse_input(&input)?;
        let hunks = match parse_patch(&input.patch) {
            Ok(hunks) => hunks,
            Err(error) => return Ok(verification_error(error)),
        };
        if hunks.is_empty() {
            return Ok(verification_error("No files were modified."));
        }

        let cwd = ctx.state.cwd();
        let mut touched: Vec<PathBuf> = Vec::new();
        let mut staged: Vec<StagedChange> = Vec::new();

        // Preflight: resolve + reject duplicate targets + enforce write scope and
        // sandbox for EVERY path before any computation (edit.rs:93-107, batched).
        for hunk in &hunks {
            let (source, destination) = match hunk {
                Hunk::Add { path, .. } | Hunk::Delete { path } => (resolve_path(path, &cwd), None),
                Hunk::Update {
                    path,
                    move_to: None,
                    ..
                } => (resolve_path(path, &cwd), None),
                Hunk::Update {
                    path,
                    move_to: Some(target),
                    ..
                } => (resolve_path(path, &cwd), Some(resolve_path(target, &cwd))),
            };
            for candidate in std::iter::once(source).chain(destination) {
                if touched.contains(&candidate) {
                    return Ok(verification_error(format!(
                        "multiple operations target {}",
                        candidate.display()
                    )));
                }
                if let Err(error) = ctx.check_allowed_write_path(&candidate) {
                    return Ok(ToolOutput::error(error));
                }
                if let Some(sandbox) = &ctx.sandbox {
                    sandbox
                        .check_path(&candidate, true)
                        .map_err(ToolError::Execution)?;
                }
                touched.push(candidate);
            }
        }

        // Verify: compute every final file state in memory; any failure returns
        // before the first write.
        for hunk in hunks {
            match hunk {
                Hunk::Add { path, lines } => {
                    let mut new_text = lines.join("\n");
                    new_text.push('\n');
                    staged.push(StagedChange {
                        path: resolve_path(&path, &cwd),
                        moved_from: None,
                        kind: ChangeKind::Added,
                        encoding: TextEncoding::Utf8 { bom: false },
                        line_endings: LineEndings::Lf,
                        old_text: String::new(),
                        new_text,
                    });
                }
                Hunk::Delete { path } => {
                    let resolved = resolve_path(&path, &cwd);
                    match tokio::fs::metadata(&resolved).await {
                        Ok(metadata) if metadata.is_dir() => {
                            return Ok(verification_error(format!(
                                "cannot delete directory {}",
                                resolved.display()
                            )));
                        }
                        Ok(_) => {}
                        Err(error) => {
                            return Ok(verification_error(format!(
                                "Failed to read file to delete {}: {error}",
                                resolved.display()
                            )));
                        }
                    }
                    // 修订 D5：不解码内容——read_text_file 对非 UTF-8/非 UTF-16LE
                    // 字节返回 invalid_data，二进制文件会因此无法删除（codex 用
                    // read_file_text(...).ok() 容忍读取失败）。Delete 路径不产生
                    // diff/artifact，old_text/encoding 本就无人消费。
                    staged.push(StagedChange {
                        path: resolved,
                        moved_from: None,
                        kind: ChangeKind::Deleted,
                        encoding: TextEncoding::Utf8 { bom: false },
                        line_endings: LineEndings::Lf,
                        old_text: String::new(),
                        new_text: String::new(),
                    });
                }
                Hunk::Update {
                    path,
                    move_to,
                    chunks,
                } => {
                    let source = resolve_path(&path, &cwd);
                    let text_file = match read_text_file(&source).await {
                        Ok(text_file) => text_file,
                        Err(error) => {
                            return Ok(verification_error(format!(
                                "Failed to read file to update {}: {error}",
                                source.display()
                            )));
                        }
                    };
                    let new_text = match apply_chunks(&text_file.content, &chunks) {
                        Ok(new_text) => new_text,
                        Err(error) => return Ok(verification_error(error)),
                    };
                    let (destination, moved_from) = match &move_to {
                        Some(target) => (resolve_path(target, &cwd), Some(source.clone())),
                        None => (source.clone(), None),
                    };
                    staged.push(StagedChange {
                        path: destination,
                        moved_from,
                        kind: ChangeKind::Modified,
                        encoding: text_file.encoding,
                        line_endings: text_file.line_endings,
                        old_text: text_file.content,
                        new_text,
                    });
                }
            }
        }

        // Commit: writes happen only after ALL hunks verified. A mid-write IO
        // failure surfaces as ToolError::Execution; completed writes remain
        // (same partial-write semantics as codex), each already recorded.
        let mut output_text = String::from("Applied patch:\n");
        let mut artifacts: Vec<(PathBuf, String)> = Vec::new();
        for change in &staged {
            let marker = match change.kind {
                ChangeKind::Added => "A",
                ChangeKind::Modified => "M",
                ChangeKind::Deleted => "D",
            };
            let lsp_baseline = if change.kind == ChangeKind::Deleted {
                None
            } else {
                Some(crate::lsp::snapshot_baseline(ctx, &change.path, Some(&change.old_text)).await)
            };
            if let Some(parent) = change.path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|error| {
                    ToolError::Execution(format!("failed to create parent dir: {error}"))
                })?;
            }
            if change.kind == ChangeKind::Deleted {
                tokio::fs::remove_file(&change.path)
                    .await
                    .map_err(|error| {
                        ToolError::Execution(format!(
                            "failed to delete {}: {error}",
                            change.path.display()
                        ))
                    })?;
            } else {
                write_text_file(
                    &change.path,
                    &change.new_text,
                    change.encoding,
                    change.line_endings,
                )
                .await
                .map_err(|error| {
                    ToolError::Execution(format!(
                        "failed to write {}: {error}",
                        change.path.display()
                    ))
                })?;
                if let Some(source) = &change.moved_from {
                    let _ = tokio::fs::remove_file(source).await;
                }
                ctx.state.record_file_read(
                    change.path.clone(),
                    Some(change.new_text.clone()),
                    file_modified_time(&change.path),
                    None,
                    None,
                );
                if let Some(source) = &change.moved_from {
                    ctx.state.record_file_read(
                        source.clone(),
                        Some(String::new()),
                        None,
                        None,
                        None,
                    );
                }
            }
            output_text.push_str(&format!("{marker} {}\n", change.path.display()));
            if change.kind != ChangeKind::Deleted {
                let diff = format_file_diff(&change.old_text, &change.new_text);
                output_text.push_str(&format!("```diff\n{diff}```\n"));
                if let Some(baseline) = lsp_baseline {
                    output_text = crate::lsp::append_post_write_diagnostics(
                        output_text,
                        &change.path,
                        baseline,
                        &change.new_text,
                    )
                    .await;
                }
                artifacts.push((
                    change.path.clone(),
                    format!("{:x}", Sha256::digest(change.new_text.as_bytes())),
                ));
            }
        }
        let mut result = ToolOutput::text(output_text);
        for (path, sha256) in artifacts {
            result =
                result.with_execution_metadata(ToolExecutionMetadata::Artifact { path, sha256 });
        }
        Ok(result)
    }
}
