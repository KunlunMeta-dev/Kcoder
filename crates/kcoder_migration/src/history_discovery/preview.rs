//! Display-only metadata samples. Samples never determine a continuation context.
use super::*;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

const SAMPLE: usize = 64 * 1024;
pub(super) struct Preview {
    pub title: Option<String>,
    pub project: Option<String>,
    pub incomplete: bool,
    pub parent_session_id: Option<String>,
}

struct Checked<'a, R, C> {
    reader: R,
    check: &'a mut C,
}
impl<R: Read, C: FnMut() -> bool> Read for Checked<'_, R, C> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if !(self.check)() {
            return Err(std::io::Error::other("history_discovery_cancelled"));
        }
        let count = buffer.len().min(16 * 1024);
        self.reader.read(&mut buffer[..count])
    }
}

pub(super) fn read(
    selected: &HistoryFileSelection,
    check: &mut impl FnMut() -> bool,
) -> Result<Preview> {
    read_inner(selected, false, check)
}

pub(super) fn read_pinned(
    selected: &HistoryFileSelection,
    check: &mut impl FnMut() -> bool,
) -> Result<Preview> {
    read_inner(selected, true, check)
}

fn read_inner(
    selected: &HistoryFileSelection,
    pinned: bool,
    check: &mut impl FnMut() -> bool,
) -> Result<Preview> {
    ensure!(check(), "history_discovery_cancelled");
    let mut file = selected.open()?;
    let current_size = file.metadata()?.len();
    ensure!(
        current_size >= selected.bytes,
        "migration_history_source_changed"
    );
    let size = if pinned { selected.bytes } else { current_size };
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut incomplete = if selected.compressed() {
        let input = Checked {
            reader: (&mut file).take(size.min(256 * 1024)),
            check,
        };
        let decoder = kcoder_state::external_history::codec::zstd_decoder(input)?;
        decoder.take(SAMPLE as u64).read_to_end(&mut head)?;
        head.len() == SAMPLE
    } else {
        Checked {
            reader: (&mut file).take(size.min(SAMPLE as u64)),
            check,
        }
        .read_to_end(&mut head)?;
        let offset = size.saturating_sub(SAMPLE as u64);
        if offset > 0 {
            file.seek(SeekFrom::Start(offset - 1))?;
            let mut before = [0];
            file.read_exact(&mut before)?;
            Checked {
                reader: (&mut file).take(SAMPLE as u64),
                check,
            }
            .read_to_end(&mut tail)?;
            if before[0] != b'\n' {
                if let Some(end) = tail.iter().position(|b| *b == b'\n') {
                    tail.drain(..=end);
                } else {
                    tail.clear();
                }
            }
        }
        size > (2 * SAMPLE) as u64
    };
    ensure!(check(), "history_discovery_cancelled");
    drop(selected.open()?);
    let mut metadata = Fields::default();
    for bytes in [&head, &tail] {
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                metadata.observe(&value);
            } else {
                incomplete = true;
            }
        }
    }
    incomplete |= size != selected.bytes;
    Ok(Preview {
        title: metadata
            .custom
            .or(metadata.ai)
            .or(metadata.last_prompt)
            .or(metadata.summary)
            .or(metadata.first_prompt),
        project: metadata.project,
        parent_session_id: metadata.parent_session_id,
        incomplete: incomplete || head.is_empty(),
    })
}

#[derive(Default)]
struct Fields {
    custom: Option<String>,
    ai: Option<String>,
    summary: Option<String>,
    last_prompt: Option<String>,
    first_prompt: Option<String>,
    project: Option<String>,
    parent_session_id: Option<String>,
}
fn bounded(value: &Value, key: &str, limit: usize) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(limit).collect())
}
fn prompt(value: &Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    if kind == "user"
        && value.get("isMeta").and_then(Value::as_bool) != Some(true)
        && value.get("isCompactSummary").and_then(Value::as_bool) != Some(true)
    {
        return message_prompt(value.get("message")?);
    }
    if kind == "response_item"
        && value.pointer("/payload/type").and_then(Value::as_str) == Some("message")
    {
        return message_prompt(value.get("payload")?);
    }
    None
}
fn message_prompt(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let text = if let Some(text) = content.as_str() {
        Some(text)
    } else {
        let blocks = content.as_array()?;
        if blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        {
            return None;
        }
        blocks
            .iter()
            .filter(|block| {
                matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("text" | "input_text")
                )
            })
            .find_map(|block| block.get("text").and_then(Value::as_str))
    }?;
    let text = text.trim();
    if text.is_empty() || text.starts_with('<') || text.starts_with("[Request interrupted by user")
    {
        return None;
    }
    Some(text.chars().take(200).collect())
}
impl Fields {
    fn observe(&mut self, value: &Value) {
        if let Some(title) = bounded(value, "customTitle", 200) {
            self.custom = Some(title)
        }
        if let Some(title) = bounded(value, "aiTitle", 200) {
            self.ai = Some(title)
        }
        if let Some(title) = bounded(value, "summary", 200) {
            self.summary = Some(title)
        }
        if let Some(title) = bounded(value, "lastPrompt", 200) {
            self.last_prompt = Some(title)
        }
        if value.get("type").and_then(Value::as_str) == Some("session_meta")
            && let Some(payload) = value.get("payload")
        {
            self.project = bounded(payload, "cwd", 4096).or(self.project.take());
            self.parent_session_id = payload
                .get("parent_thread_id")
                .or_else(|| payload.get("forked_from_id"))
                .and_then(Value::as_str)
                .and_then(canonical_uuid)
                .or(self.parent_session_id.take());
            if let Some(title) = bounded(payload, "thread_name", 200) {
                self.custom = Some(title)
            }
        }
        self.project = self.project.take().or_else(|| bounded(value, "cwd", 4096));
        if self.first_prompt.is_none() {
            self.first_prompt = prompt(value)
        }
    }
}
