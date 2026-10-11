//! Spec render adapter behavior; domain operations remain in kcoder_specs.

use super::*;

pub(super) fn render_lessons_skill(
    cwd: &Path,
    change_name: &str,
    archive_dir: &Path,
    skill_name: &str,
) -> Result<String, ToolError> {
    let capability = change_name.replace('-', " ");
    let relative_archive = archive_dir.strip_prefix(cwd).unwrap_or(archive_dir);
    let mut content = String::new();
    let _ = writeln!(content, "---");
    let _ = writeln!(content, "name: {skill_name}");
    let _ = writeln!(
        content,
        "description: Use when working on {capability} to reuse lessons from archived spec change `{change_name}`."
    );
    let _ = writeln!(content, "---\n");
    let _ = writeln!(content, "# Lessons Learned: {capability}\n");
    let _ = writeln!(
        content,
        "From archived change `{change_name}` at `{}`.\n",
        relative_archive.display()
    );

    let proposal = read_optional(archive_dir.join("proposal.md"))?;
    let design = read_optional(archive_dir.join("design.md"))?;
    let tasks = read_optional(archive_dir.join("tasks.md"))?;
    let specs = collect_archived_spec_markdown(archive_dir)?;

    write_section(
        &mut content,
        "Context",
        extract_relevant_lines(&[proposal.as_deref(), design.as_deref()], 6),
        &[
            format!("Review archived change `{change_name}` before making related changes."),
            format!(
                "Use `{}` as the source artifact for full detail.",
                relative_archive.display()
            ),
        ],
    );
    write_section(
        &mut content,
        "Pitfalls",
        extract_keyword_lines(
            &[proposal.as_deref(), design.as_deref(), tasks.as_deref()],
            &[
                "risk",
                "pitfall",
                "caution",
                "block",
                "conflict",
                "migration",
                "rollback",
            ],
            8,
        ),
        &[format!(
            "Check proposal, design, and tasks from `{change_name}` for assumptions before reusing this approach."
        )],
    );
    write_section(
        &mut content,
        "Verification Steps",
        extract_keyword_lines(
            &[proposal.as_deref(), design.as_deref(), tasks.as_deref()],
            &["test", "verify", "validation", "precheck", "cargo", "run"],
            8,
        ),
        &[
            "Run the archived change's verification steps before claiming related work is complete.".to_string(),
            "Prefer project-specific precheck commands from `.kcoder/specs/config.yaml` when present.".to_string(),
        ],
    );
    write_section(
        &mut content,
        "Relevant Requirements",
        extract_relevant_lines(
            &specs
                .iter()
                .map(String::as_str)
                .map(Some)
                .collect::<Vec<_>>(),
            8,
        ),
        &[format!(
            "Inspect `{}/specs/` for the merged requirements that motivated this lesson.",
            relative_archive.display()
        )],
    );

    Ok(content)
}

pub(super) fn write_section(
    content: &mut String,
    title: &str,
    items: Vec<String>,
    fallback: &[String],
) {
    let _ = writeln!(content, "## {title}");
    let items = if items.is_empty() {
        fallback.to_vec()
    } else {
        items
    };
    for item in items {
        let _ = writeln!(content, "- {}", item.trim());
    }
    content.push('\n');
}

pub(super) fn read_optional(path: impl AsRef<Path>) -> Result<Option<String>, ToolError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))
}

pub(super) fn collect_archived_spec_markdown(archive_dir: &Path) -> Result<Vec<String>, ToolError> {
    let specs_dir = archive_dir.join("specs");
    if !specs_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_markdown_files(&specs_dir, &mut files)?;
    files.sort();
    files
        .into_iter()
        .map(|path| {
            fs::read_to_string(&path)
                .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))
        })
        .collect()
}

pub(super) fn extract_relevant_lines(inputs: &[Option<&str>], limit: usize) -> Vec<String> {
    let mut items = Vec::new();
    for input in inputs.iter().flatten() {
        for line in input.lines() {
            let raw = line.trim();
            if !is_heading_or_list_item(raw) {
                continue;
            }
            let line = clean_lesson_line(line);
            if line.is_empty() || line == "---" {
                continue;
            }
            push_unique_lesson(&mut items, line, limit);
            if items.len() >= limit {
                return items;
            }
        }
    }
    items
}

pub(super) fn extract_keyword_lines(
    inputs: &[Option<&str>],
    keywords: &[&str],
    limit: usize,
) -> Vec<String> {
    let mut items = Vec::new();
    for input in inputs.iter().flatten() {
        for line in input.lines() {
            let line = clean_lesson_line(line);
            let lower = line.to_ascii_lowercase();
            if !line.is_empty() && keywords.iter().any(|keyword| lower.contains(keyword)) {
                push_unique_lesson(&mut items, line, limit);
                if items.len() >= limit {
                    return items;
                }
            }
        }
    }
    items
}

pub(super) fn clean_lesson_line(line: &str) -> String {
    line.trim()
        .trim_start_matches('#')
        .trim_start_matches('-')
        .trim_start_matches('*')
        .trim()
        .to_string()
}

pub(super) fn is_heading_or_list_item(line: &str) -> bool {
    line.starts_with('#')
        || line.starts_with('-')
        || line.starts_with('*')
        || line.contains("SHALL")
}

pub(super) fn push_unique_lesson(items: &mut Vec<String>, item: String, limit: usize) {
    if item.len() > 240 || items.iter().any(|existing| existing == &item) {
        return;
    }
    if items.len() < limit {
        items.push(item);
    }
}

pub(super) fn sanitize_skill_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "change".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn collect_spec_show_files(
    change_dir: &std::path::Path,
    root: &std::path::Path,
    max_file_bytes: usize,
    files: &mut Vec<Value>,
) -> Result<(), ToolError> {
    let mut entries = Vec::new();
    collect_markdown_files(root, &mut entries)?;
    entries.sort();
    for path in entries {
        files.push(read_spec_show_file(change_dir, &path, max_file_bytes)?);
    }
    Ok(())
}

pub(super) fn collect_markdown_files(
    root: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), ToolError> {
    for entry in fs::read_dir(root)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", root)))?
    {
        let path = entry
            .map_err(|e| ToolError::Execution(format!("failed to read directory entry: {e}")))?
            .path();
        if path.is_dir() {
            collect_markdown_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

pub(super) fn read_spec_show_file(
    change_dir: &std::path::Path,
    path: &std::path::Path,
    max_file_bytes: usize,
) -> Result<Value, ToolError> {
    let content = fs::read_to_string(path)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))?;
    let truncated = content.len() > max_file_bytes;
    let content = if truncated {
        truncate_utf8(&content, max_file_bytes).to_string()
    } else {
        content
    };
    let relative = path.strip_prefix(change_dir).unwrap_or(path);
    Ok(serde_json::json!({
        "path": relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
        "truncated": truncated,
        "content": content,
    }))
}

pub(super) fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
