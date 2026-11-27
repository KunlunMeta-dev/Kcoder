//! Incremental extraction of whitelisted visualization strings, never arbitrary tool arguments.
use kcoder_types::widgets::{
    WIDGET_PREVIEW_BYTES, WIDGET_SOURCE_BYTES, WidgetFormat, WidgetInputPreview,
};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
enum StringKind {
    Key,
    Source,
    Title,
    Format,
    Ignore,
}

pub(super) struct WidgetInputStream {
    depth: usize,
    expect_key: bool,
    last_key: String,
    string: Option<StringKind>,
    escaped: String,
    key: String,
    source: String,
    source_bytes: usize,
    source_truncated: bool,
    title: String,
    format: String,
    raw_bytes: usize,
    source_seen: bool,
    last_emitted: Option<Instant>,
    last_signature: (usize, usize, usize),
    invalid: bool,
}

impl Default for WidgetInputStream {
    fn default() -> Self {
        Self {
            depth: 0,
            expect_key: true,
            last_key: String::new(),
            string: None,
            escaped: String::new(),
            key: String::new(),
            source: String::new(),
            source_bytes: 0,
            title: String::new(),
            format: String::new(),
            raw_bytes: 0,
            source_seen: false,
            source_truncated: false,
            last_emitted: None,
            last_signature: (0, 0, 0),
            invalid: false,
        }
    }
}

impl WidgetInputStream {
    pub(super) fn push(&mut self, delta: &str) -> Result<Option<WidgetInputPreview>, &'static str> {
        self.raw_bytes = self.raw_bytes.saturating_add(delta.len());
        if self.raw_bytes > 6 * WIDGET_SOURCE_BYTES + 32 * 1024 {
            return Err("widget_quota: raw component arguments exceed the bounded input budget");
        }
        for ch in delta.chars() {
            if let Some(kind) = self.string {
                if !self.escaped.is_empty() {
                    self.escaped.push(ch);
                    match decode_escape(&self.escaped) {
                        Ok(Some(decoded)) => {
                            self.escaped.clear();
                            self.append(kind, decoded)?;
                        }
                        Ok(None) => {}
                        Err(()) => {
                            self.invalid = true;
                            self.escaped.clear();
                        }
                    }
                } else if ch == '\\' {
                    self.escaped.push(ch);
                } else if ch == '"' {
                    self.string = None;
                    if kind == StringKind::Key {
                        self.last_key = std::mem::take(&mut self.key);
                        self.expect_key = false;
                    } else {
                        self.last_key.clear();
                    }
                } else if ch < '\u{20}' {
                    self.invalid = true;
                } else {
                    self.append(kind, ch)?;
                }
            } else {
                match ch {
                    '{' | '[' => {
                        self.depth += 1;
                        if self.depth == 1 {
                            self.expect_key = true;
                        }
                    }
                    '}' | ']' => self.depth = self.depth.saturating_sub(1),
                    ',' if self.depth == 1 => {
                        self.expect_key = true;
                        self.last_key.clear();
                    }
                    '"' => {
                        let kind = if self.depth == 1 && self.expect_key {
                            self.key.clear();
                            StringKind::Key
                        } else if self.depth == 1 {
                            match self.last_key.as_str() {
                                "widget_code" => {
                                    self.source.clear();
                                    self.source_bytes = 0;
                                    self.source_truncated = false;
                                    self.source_seen = true;
                                    StringKind::Source
                                }
                                "title" => {
                                    self.title.clear();
                                    StringKind::Title
                                }
                                "format" => {
                                    self.format.clear();
                                    StringKind::Format
                                }
                                _ => StringKind::Ignore,
                            }
                        } else {
                            StringKind::Ignore
                        };
                        self.string = Some(kind);
                    }
                    _ => {}
                }
            }
        }
        Ok(self.snapshot(false, false))
    }

    fn append(&mut self, kind: StringKind, ch: char) -> Result<(), &'static str> {
        match kind {
            StringKind::Source => {
                self.source_bytes = self.source_bytes.saturating_add(ch.len_utf8());
                if self.source_bytes > WIDGET_SOURCE_BYTES {
                    return Err("widget_quota: decoded component source exceeds 1 MiB");
                }
                if !self.source_truncated {
                    if self.source.len() + ch.len_utf8() <= WIDGET_PREVIEW_BYTES {
                        self.source.push(ch);
                    } else {
                        self.source_truncated = true;
                    }
                }
            }
            StringKind::Key if self.key.len() < 128 => self.key.push(ch),
            StringKind::Title if self.title.len() + ch.len_utf8() <= 256 => self.title.push(ch),
            StringKind::Format if self.format.len() < 16 => self.format.push(ch),
            _ => {}
        }
        Ok(())
    }

    pub(super) fn snapshot(&mut self, force: bool, complete: bool) -> Option<WidgetInputPreview> {
        if self.invalid || !self.source_seen {
            return None;
        }
        let signature = (self.source_bytes, self.title.len(), self.format.len());
        if !force
            && (self
                .last_emitted
                .is_some_and(|time| time.elapsed() < Duration::from_millis(100))
                || signature == self.last_signature)
        {
            return None;
        }
        self.last_signature = signature;
        self.last_emitted = Some(Instant::now());
        Some(WidgetInputPreview {
            source: self.source.clone(),
            title: (!self.title.is_empty()).then(|| self.title.clone()),
            format: if self.format == "svg" {
                WidgetFormat::Svg
            } else {
                WidgetFormat::Html
            },
            bytes: self.source_bytes,
            truncated: self.source.len() < self.source_bytes,
            complete,
        })
    }
}

fn decode_escape(raw: &str) -> Result<Option<char>, ()> {
    if raw.len() < 2 {
        return Ok(None);
    }
    let bytes = raw.as_bytes();
    if bytes[1] != b'u' {
        return match bytes[1] {
            b'"' => Ok(Some('"')),
            b'\\' => Ok(Some('\\')),
            b'/' => Ok(Some('/')),
            b'n' => Ok(Some('\n')),
            b'r' => Ok(Some('\r')),
            b't' => Ok(Some('\t')),
            b'b' => Ok(Some('\u{8}')),
            b'f' => Ok(Some('\u{c}')),
            _ => Err(()),
        };
    }
    if raw.len() < 6 {
        return Ok(None);
    }
    let first = u16::from_str_radix(raw.get(2..6).ok_or(())?, 16).map_err(|_| ())?;
    if (0xd800..=0xdbff).contains(&first) {
        if raw.len() < 12 {
            return Ok(None);
        }
        if raw.get(6..8) != Some("\\u") {
            return Err(());
        }
        let second = u16::from_str_radix(raw.get(8..12).ok_or(())?, 16).map_err(|_| ())?;
        if !(0xdc00..=0xdfff).contains(&second) {
            return Err(());
        }
        char::from_u32(0x10000 + ((first as u32 - 0xd800) << 10) + (second as u32 - 0xdc00))
            .map(Some)
            .ok_or(())
    } else {
        char::from_u32(first as u32).map(Some).ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_character_fragment_preserves_escapes_and_excludes_other_fields() {
        let mut stream = WidgetInputStream::default();
        let raw = r#"{"title":"Diagram","secret":"never preview","nested":{"widget_code":"wrong"},"format":"svg","widget_code":"<svg>\uD83D\uDE00\n\"label\"</svg>"}"#;
        for ch in raw.chars() {
            stream.push(&ch.to_string()).unwrap();
        }
        let result = stream.snapshot(true, true).unwrap();
        assert_eq!(result.source, "<svg>😀\n\"label\"</svg>");
        assert_eq!(result.format, WidgetFormat::Svg);
        assert!(!result.source.contains("wrong"));
    }
    #[test]
    fn preview_is_utf8_bounded_and_tracks_real_decoded_size() {
        let text = "界".repeat(10000);
        let raw = serde_json::json!({"widget_code":text}).to_string();
        let mut stream = WidgetInputStream::default();
        stream.push(&raw).unwrap();
        let preview = stream.snapshot(true, true).unwrap();
        assert!(preview.source.len() <= WIDGET_PREVIEW_BYTES);
        assert_eq!(preview.bytes, 30000);
        assert!(preview.truncated);
    }
    #[test]
    fn raw_and_decoded_limits_are_enforced_during_generation() {
        let mut stream = WidgetInputStream::default();
        stream.push("{\"widget_code\":\"").unwrap();
        assert!(stream.push(&"x".repeat(WIDGET_SOURCE_BYTES + 1)).is_err());
    }
}
