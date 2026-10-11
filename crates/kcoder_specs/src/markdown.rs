//! Spec markdown domain implementation.

use super::*;

pub(super) fn append_markdown_list_section(
    content: &str,
    title: &str,
    additions: &[String],
) -> String {
    let mut items = markdown_section(content, title)
        .map(section_items)
        .unwrap_or_default();
    push_unique_markdown_items(&mut items, additions);
    upsert_markdown_section(content, title, &markdown_items_body(&items))
}

pub(super) fn append_review_followup_tasks(tasks: &str, followups: &[String]) -> String {
    let followups = clean_markdown_items(followups)
        .into_iter()
        .filter(|item| !tasks.contains(item))
        .collect::<Vec<_>>();
    if followups.is_empty() {
        return tasks.to_string();
    }

    let group = next_task_group_number(tasks);
    let mut out = tasks.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("## {group}. Review Follow-Up\n\n"));
    for (idx, item) in followups.iter().enumerate() {
        out.push_str(&format!("- [ ] {group}.{} {}\n", idx + 1, item));
    }
    out
}

pub(super) fn next_task_group_number(tasks: &str) -> usize {
    numbered_ids(tasks)
        .into_iter()
        .filter_map(|id| id.split('.').next().and_then(|group| group.parse().ok()))
        .max()
        .unwrap_or(0)
        + 1
}

pub(super) fn append_verification_notes(existing: &str, notes: &[String]) -> String {
    let mut content = if existing.trim().is_empty() {
        "# Verification\n".to_string()
    } else {
        existing.to_string()
    };

    let completion_decision = section_value(Some(&content), "Completion Decision", "pending");
    let commands_run = markdown_section(&content, "Commands Run").unwrap_or_else(|| "none".into());
    let manual_checks =
        markdown_section(&content, "Manual Checks").unwrap_or_else(|| "none".into());
    let evidence = markdown_section(&content, "Evidence").unwrap_or_else(|| "none".into());
    let manual_adjustments =
        markdown_section(&content, "Manual Adjustments").unwrap_or_else(|| "none".into());
    let previous_iterations = markdown_section(&content, "Previous Iterations");

    let mut residual_risks = markdown_section(&content, "Residual Risks")
        .map(section_items)
        .unwrap_or_default();
    push_unique_markdown_items(&mut residual_risks, notes);

    content = upsert_markdown_section(&content, "Completion Decision", &completion_decision);
    content = upsert_markdown_section(&content, "Commands Run", &commands_run);
    content = upsert_markdown_section(&content, "Manual Checks", &manual_checks);
    content = upsert_markdown_section(&content, "Evidence", &evidence);
    content = upsert_markdown_section(
        &content,
        "Residual Risks",
        &markdown_items_body(&residual_risks),
    );
    if let Some(previous_iterations) = previous_iterations {
        content = upsert_markdown_section(&content, "Previous Iterations", &previous_iterations);
    }
    upsert_markdown_section(&content, "Manual Adjustments", &manual_adjustments)
}

pub(super) fn push_unique_markdown_items(items: &mut Vec<String>, additions: &[String]) {
    for item in clean_markdown_items(additions) {
        if !items
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&item))
        {
            items.push(item);
        }
    }
}

pub(super) fn markdown_list_body(items: &[String]) -> String {
    markdown_items_body(&clean_markdown_items(items))
}

pub(super) fn markdown_items_body(items: &[String]) -> String {
    if items.is_empty() {
        return "none".to_string();
    }
    items
        .iter()
        .map(|item| format!("- {}", item.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn clean_markdown_items(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !is_none_like(item))
        .map(ToString::to_string)
        .collect()
}

pub(super) fn upsert_markdown_section(content: &str, title: &str, body: &str) -> String {
    let heading = format!("## {title}");
    let body = normalize_markdown_body(body);
    let lines = content.lines().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut idx = 0;
    let mut replaced = false;

    while idx < lines.len() {
        if lines[idx].trim().eq_ignore_ascii_case(&heading) {
            push_markdown_section(&mut out, &heading, &body);
            replaced = true;
            idx += 1;
            while idx < lines.len() && !lines[idx].trim_start().starts_with("## ") {
                idx += 1;
            }
        } else {
            out.push(lines[idx].to_string());
            idx += 1;
        }
    }

    if !replaced {
        while out.last().is_some_and(|line| line.trim().is_empty()) {
            out.pop();
        }
        if !out.is_empty() {
            out.push(String::new());
        }
        push_markdown_section(&mut out, &heading, &body);
    }

    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

pub(super) fn normalize_markdown_body(body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        "none".to_string()
    } else {
        body.to_string()
    }
}

pub(super) fn push_markdown_section(out: &mut Vec<String>, heading: &str, body: &str) {
    out.push(heading.to_string());
    out.push(String::new());
    out.extend(body.lines().map(ToString::to_string));
    out.push(String::new());
}

pub(super) fn write_markdown_value(content: &mut String, title: &str, value: &str) {
    content.push_str("## ");
    content.push_str(title);
    content.push_str("\n\n");
    if value.trim().is_empty() {
        content.push_str("none\n\n");
    } else {
        content.push_str(value.trim());
        content.push_str("\n\n");
    }
}

pub(super) fn write_markdown_list(content: &mut String, title: &str, items: &[String]) {
    content.push_str("## ");
    content.push_str(title);
    content.push_str("\n\n");
    let mut wrote = false;
    for item in items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        content.push_str("- ");
        content.push_str(item);
        content.push('\n');
        wrote = true;
    }
    if !wrote {
        content.push_str("none\n");
    }
    content.push('\n');
}
