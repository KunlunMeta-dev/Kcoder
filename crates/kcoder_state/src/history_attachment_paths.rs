//! Portable references for attachments owned by a session's client storage.
//!
//! The transcript stays the authority for the message. New attachment paths
//! are stored relative to the profile root; legacy absolute paths and paths
//! owned outside this session are left unchanged.

use anyhow::Result;
use kcoder_types::Message;
use serde_json::Value;
use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

const ATTACHMENTS_OPEN: &str = "<kcoder_attachments version=\"1\">\n";
const ATTACHMENTS_CLOSE: &str = "\n</kcoder_attachments>";

fn profile_root(history_path: &Path) -> Option<PathBuf> {
    let parent = history_path.parent()?;
    if !history_path.is_absolute() || parent.parent()?.file_name()?.to_str()? != "projects" {
        return None;
    }
    Some(parent.parent()?.parent()?.to_path_buf())
}

fn profile_attachment_root(
    history_path: &Path,
    session_id: &str,
) -> Option<(PathBuf, PathBuf, String)> {
    let parent = history_path.parent()?;
    let component = crate::artifact_id_path_component(session_id);
    if history_path.file_stem().and_then(|stem| stem.to_str()) != Some(component.as_str()) {
        return None;
    }
    let profile_root = profile_root(history_path)?;
    let project_key = parent.file_name()?.to_str()?.to_owned();
    let attachment_root = parent
        .join("client-sessions")
        .join(component)
        .join("attachments");
    Some((profile_root, attachment_root, project_key))
}

fn safe_relative_parts(path: &Path) -> Option<Vec<&str>> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if part.is_empty() || part.contains(['/', '\\', ':']) || part.chars().any(char::is_control)
        {
            return None;
        }
        parts.push(part);
    }
    Some(parts)
}

fn relative_reference(
    path: &Path,
    profile_root: &Path,
    root: &Path,
    project_key: &str,
    session_id: &str,
) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let root_parts = safe_relative_parts(root.strip_prefix(profile_root).ok()?)?;
    let tail_parts = safe_relative_parts(path.strip_prefix(root).ok()?)?;
    if root_parts.len() != 5
        || root_parts[0] != "projects"
        || root_parts[1] != project_key
        || root_parts[2] != "client-sessions"
        || root_parts[3] != crate::artifact_id_path_component(session_id)
        || root_parts[4] != "attachments"
        || tail_parts.is_empty()
    {
        return None;
    }
    Some(
        root_parts
            .into_iter()
            .chain(tail_parts)
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn resolve_reference(path: &str, history_path: &Path) -> Option<String> {
    if path.contains('\\') || path.contains("//") || path.ends_with('/') {
        return None;
    }
    let profile_root = profile_root(history_path)?;
    let relative = Path::new(path);
    let parts = safe_relative_parts(relative)?;
    if parts.len() < 6
        || parts[0] != "projects"
        || parts[2] != "client-sessions"
        || parts[4] != "attachments"
    {
        return None;
    }
    Some(profile_root.join(relative).to_str()?.to_owned())
}

fn rewrite_prompt(
    text: &str,
    session_id: &str,
    history_path: &Path,
    encode: bool,
) -> Result<Option<String>> {
    let Some(open) = text.rfind(ATTACHMENTS_OPEN) else {
        return Ok(None);
    };
    if !text.ends_with(ATTACHMENTS_CLOSE) {
        return Ok(None);
    }
    let body_start = open + ATTACHMENTS_OPEN.len();
    let body_end = text.len() - ATTACHMENTS_CLOSE.len();
    let attachment_root = profile_attachment_root(history_path, session_id);
    let mut changed = false;
    let mut records = Vec::new();
    for line in text[body_start..body_end].lines() {
        let Ok(mut record) = serde_json::from_str::<Value>(line) else {
            return Ok(None);
        };
        let Some(path) = record.get("path").and_then(Value::as_str) else {
            records.push(line.to_owned());
            continue;
        };
        let replacement = if encode {
            attachment_root
                .as_ref()
                .and_then(|(profile, root, project)| {
                    relative_reference(Path::new(path), profile, root, project, session_id)
                })
        } else if Path::new(path).is_absolute() {
            None
        } else {
            resolve_reference(path, history_path)
        };
        if let Some(replacement) = replacement
            && replacement != path
        {
            record["path"] = Value::String(replacement);
            changed = true;
            records.push(serde_json::to_string(&record)?);
        } else {
            records.push(line.to_owned());
        }
    }
    if !changed {
        return Ok(None);
    }
    Ok(Some(format!(
        "{}{}{}",
        &text[..body_start],
        records.join("\n"),
        ATTACHMENTS_CLOSE
    )))
}

fn rewrite_content(
    content: &mut Value,
    session_id: &str,
    history_path: &Path,
    encode: bool,
) -> Result<bool> {
    fn rewrite_text(
        text: &mut String,
        session_id: &str,
        history_path: &Path,
        encode: bool,
    ) -> Result<bool> {
        if let Some(updated) = rewrite_prompt(text, session_id, history_path, encode)? {
            *text = updated;
            return Ok(true);
        }
        Ok(false)
    }
    Ok(match content {
        Value::String(text) => rewrite_text(text, session_id, history_path, encode)?,
        Value::Array(blocks) => {
            let mut changed = false;
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(Value::String(text)) = block.get_mut("text")
                {
                    changed |= rewrite_text(text, session_id, history_path, encode)?;
                }
            }
            changed
        }
        _ => false,
    })
}

fn rewrite_value(value: &mut Value, history_path: &Path, encode: bool) -> Result<bool> {
    let Some(session_id) = value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Ok(false);
    };
    value.get_mut("content").map_or(Ok(false), |content| {
        rewrite_content(content, &session_id, history_path, encode)
    })
}

pub(crate) fn encode_message(
    history_path: &Path,
    session_id: &str,
    message: &Message,
) -> Result<Message> {
    rewrite_message(history_path, session_id, message, true)
}

pub(crate) fn decode_message(
    history_path: &Path,
    session_id: &str,
    message: &Message,
) -> Result<Message> {
    rewrite_message(history_path, session_id, message, false)
}

fn rewrite_message(
    history_path: &Path,
    session_id: &str,
    message: &Message,
    encode: bool,
) -> Result<Message> {
    let mut value = serde_json::to_value(message)?;
    if let Some(content) = value.get_mut("content") {
        rewrite_content(content, session_id, history_path, encode)?;
    }
    Ok(serde_json::from_value(value)?)
}

pub(crate) fn encode_entry(history_path: &Path, entry: &mut crate::HistoryEntry) -> Result<()> {
    entry.message = encode_message(history_path, &entry.session_id, &entry.message)?;
    Ok(())
}

pub(crate) fn decode_entry(history_path: &Path, entry: &mut crate::HistoryEntry) -> Result<()> {
    entry.message = decode_message(history_path, &entry.session_id, &entry.message)?;
    Ok(())
}

pub(crate) fn encode_jsonl<'a>(history_path: &Path, bytes: &'a [u8]) -> Result<Cow<'a, [u8]>> {
    if !bytes
        .windows(ATTACHMENTS_OPEN.len())
        .any(|window| window == ATTACHMENTS_OPEN.as_bytes())
    {
        return Ok(Cow::Borrowed(bytes));
    }
    rewrite_jsonl(history_path, bytes, true)
}

pub(crate) fn decode_value(history_path: &Path, value: &mut Value) -> Result<()> {
    rewrite_value(value, history_path, false).map(|_| ())
}

fn rewrite_jsonl<'a>(history_path: &Path, bytes: &'a [u8], encode: bool) -> Result<Cow<'a, [u8]>> {
    let mut output = Vec::with_capacity(bytes.len());
    let mut changed = false;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        let value = match serde_json::from_slice::<Value>(content) {
            Ok(value) => value,
            Err(_) => {
                output.extend_from_slice(line);
                continue;
            }
        };
        let mut value = value;
        if !rewrite_value(&mut value, history_path, encode)? {
            output.extend_from_slice(line);
        } else {
            serde_json::to_writer(&mut output, &value)?;
            if line.ends_with(b"\n") {
                output.push(b'\n');
            }
            changed = true;
        }
    }
    if !changed {
        return Ok(Cow::Borrowed(bytes));
    }
    Ok(Cow::Owned(output))
}
