use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WRITE_PREVIEW_LINES: usize = 10;

const WRITE_PREVIEW_MAX_LINE_CHARS: usize = 1_000;

/// Bounded, display-safe shape of a streamed `write` input.
///
/// The engine keeps the full partial JSON for eventual tool execution, but the
/// TUI only receives this small snapshot. Streaming snapshots follow the tail,
/// while completed snapshots show the head.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WriteInputPreview {
    pub path: Option<String>,
    pub lines: Vec<String>,
    pub first_line_number: usize,
    pub total_lines: usize,
    pub complete: bool,
}

impl WriteInputPreview {
    pub(crate) fn from_partial_json(partial: &str) -> Option<Self> {
        let content = extract_partial_string_field(partial, "content")?;
        let path = extract_partial_string_field(partial, "file_path")
            .or_else(|| extract_partial_string_field(partial, "path"))
            .filter(|path| !path.is_empty());
        Some(Self::from_content(path, &content, false))
    }

    pub fn from_complete_json(input: &str) -> Option<Self> {
        let input = serde_json::from_str::<Value>(input).ok()?;
        Self::from_complete_value(&input)
    }

    pub fn from_complete_value(input: &Value) -> Option<Self> {
        let content = input.get("content")?.as_str()?;
        let path = input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|path| !path.is_empty());
        Some(Self::from_content(path, content, true))
    }

    fn from_content(path: Option<String>, content: &str, complete: bool) -> Self {
        let all_lines = content.split('\n').collect::<Vec<_>>();
        let total_lines = all_lines.len();
        let (first_line_number, selected) = if complete {
            (1, &all_lines[..all_lines.len().min(WRITE_PREVIEW_LINES)])
        } else {
            let start = all_lines.len().saturating_sub(WRITE_PREVIEW_LINES);
            (start + 1, &all_lines[start..])
        };
        let lines = selected
            .iter()
            .map(|line| cap_preview_line(line, complete))
            .collect();
        Self {
            path,
            lines,
            first_line_number,
            total_lines,
            complete,
        }
    }
}

fn cap_preview_line(line: &str, keep_head: bool) -> String {
    if line.chars().count() <= WRITE_PREVIEW_MAX_LINE_CHARS {
        return line.to_string();
    }
    if keep_head {
        let mut capped = line
            .chars()
            .take(WRITE_PREVIEW_MAX_LINE_CHARS.saturating_sub(3))
            .collect::<String>();
        capped.push_str("...");
        capped
    } else {
        let tail = line
            .chars()
            .rev()
            .take(WRITE_PREVIEW_MAX_LINE_CHARS.saturating_sub(3))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        format!("...{tail}")
    }
}

fn extract_partial_string_field(text: &str, key: &str) -> Option<String> {
    let opener = format!("\"{key}\"");
    let mut search_from = 0usize;
    while let Some(relative) = text.get(search_from..)?.find(&opener) {
        let mut cursor = search_from + relative + opener.len();
        cursor = skip_ascii_whitespace(text, cursor);
        if text.as_bytes().get(cursor) != Some(&b':') {
            search_from = cursor;
            continue;
        }
        cursor = skip_ascii_whitespace(text, cursor + 1);
        if text.as_bytes().get(cursor) != Some(&b'"') {
            search_from = cursor;
            continue;
        }
        return Some(decode_partial_json_string(text, cursor + 1));
    }
    None
}

fn skip_ascii_whitespace(text: &str, mut cursor: usize) -> usize {
    while text
        .as_bytes()
        .get(cursor)
        .is_some_and(u8::is_ascii_whitespace)
    {
        cursor += 1;
    }
    cursor
}

fn decode_partial_json_string(text: &str, mut cursor: usize) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' {
            break;
        }
        if bytes[cursor] != b'\\' {
            let Some(ch) = text[cursor..].chars().next() else {
                break;
            };
            out.push(ch);
            cursor += ch.len_utf8();
            continue;
        }

        let Some(escaped) = bytes.get(cursor + 1).copied() else {
            break;
        };
        match escaped {
            b'n' => out.push('\n'),
            b't' => out.push('\t'),
            b'r' => out.push('\r'),
            b'b' => out.push('\u{0008}'),
            b'f' => out.push('\u{000c}'),
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'u' => {
                let Some((ch, consumed)) = decode_unicode_escape(text, cursor) else {
                    break;
                };
                out.push(ch);
                cursor += consumed;
                continue;
            }
            other => out.push(other as char),
        }
        cursor += 2;
    }
    out
}

fn decode_unicode_escape(text: &str, cursor: usize) -> Option<(char, usize)> {
    let first = u16::from_str_radix(text.get(cursor + 2..cursor + 6)?, 16).ok()?;
    if (0xd800..=0xdbff).contains(&first) && text.get(cursor + 6..cursor + 8) == Some("\\u") {
        let second = u16::from_str_radix(text.get(cursor + 8..cursor + 12)?, 16).ok()?;
        if (0xdc00..=0xdfff).contains(&second) {
            let scalar =
                0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00);
            return char::from_u32(scalar).map(|ch| (ch, 12));
        }
    }
    char::from_u32(u32::from(first)).map(|ch| (ch, 6))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_preview_follows_latest_ten_lines_with_real_numbers() {
        let content = (1..=30)
            .map(|line| format!("line{line}"))
            .collect::<Vec<_>>()
            .join("\\n");
        let partial = format!(r#"{{"file_path":"src/demo.rs","content":"{content}"#);

        let preview = WriteInputPreview::from_partial_json(&partial).unwrap();

        assert_eq!(preview.path.as_deref(), Some("src/demo.rs"));
        assert_eq!(preview.first_line_number, 21);
        assert_eq!(preview.total_lines, 30);
        assert_eq!(preview.lines.first().map(String::as_str), Some("line21"));
        assert_eq!(preview.lines.last().map(String::as_str), Some("line30"));
        assert!(!preview.complete);
    }

    #[test]
    fn complete_preview_shows_first_ten_lines() {
        let content = (1..=30)
            .map(|line| format!("line{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let input = serde_json::json!({"file_path": "story.txt", "content": content});

        let preview = WriteInputPreview::from_complete_value(&input).unwrap();

        assert_eq!(preview.first_line_number, 1);
        assert_eq!(preview.total_lines, 30);
        assert_eq!(preview.lines.len(), WRITE_PREVIEW_LINES);
        assert_eq!(preview.lines.last().map(String::as_str), Some("line10"));
        assert!(preview.complete);
    }

    #[test]
    fn partial_preview_decodes_json_escapes_and_surrogate_pairs() {
        let preview = WriteInputPreview::from_partial_json(
            r#"{"path":"demo.txt","content":"first\nquote: \"ok\"\nemoji: \ud83d\ude00"#,
        )
        .unwrap();

        assert_eq!(preview.lines, ["first", "quote: \"ok\"", "emoji: 😀"]);
    }
}
