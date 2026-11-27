#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PathPreviewUpdate {
    Set(String),
    Clear,
}

const MAX_BYTES: usize = 1024 * 1024;
const MAX_STRING: usize = 4096;
const MAX_DEPTH: usize = 32;
const MAX_TOKEN: usize = 128;

#[derive(Clone, Copy)]
enum Frame {
    Object(KeyState),
    Array(ValueState),
}
#[derive(Clone, Copy)]
enum KeyState {
    First,
    Key,
    Colon,
    Value,
    End,
}
#[derive(Clone, Copy)]
enum ValueState {
    First,
    Value,
    End,
}
#[derive(Clone, Copy)]
enum StringRole {
    Key,
    Path,
    Ignore,
}
enum Escape {
    Normal,
    Slash,
    Hex(u16, u8),
    LowSlash,
    LowU,
}
struct StringToken {
    role: StringRole,
    text: String,
    escape: Escape,
    high: Option<u16>,
}
enum Token {
    String(StringToken),
    Scalar(String),
}

/// A bounded, single-pass JSON recognizer; ordinary string bodies are never retained.
pub(crate) struct PathPreviewProbe {
    dead: bool,
    bytes: usize,
    started: bool,
    stack: Vec<Frame>,
    token: Option<Token>,
    path_key: bool,
    seen_path: bool,
    preview: Option<String>,
}
impl PathPreviewProbe {
    pub(crate) fn new(tool: &str) -> Self {
        Self {
            dead: !matches!(tool, "write" | "edit"),
            bytes: 0,
            started: false,
            stack: vec![],
            token: None,
            path_key: false,
            seen_path: false,
            preview: None,
        }
    }

    pub(crate) fn push(&mut self, delta: &str) -> Vec<PathPreviewUpdate> {
        let mut updates = vec![];
        if self.dead {
            return updates;
        }
        for ch in delta.chars() {
            self.bytes += ch.len_utf8();
            if self.bytes > MAX_BYTES || !self.character(ch, &mut updates) {
                updates.extend(self.invalidate());
                break;
            }
        }
        updates
    }

    pub(crate) fn finish(&mut self, value: &serde_json::Value) -> (bool, Vec<PathPreviewUpdate>) {
        // Completion always retires temporary UI state, including mismatched final arguments.
        let valid = !self.dead
            && self.started
            && self.stack.is_empty()
            && self.token.is_none()
            && self.preview.as_deref() == value.get("file_path").and_then(|v| v.as_str());
        (valid, self.invalidate())
    }

    pub(crate) fn invalidate(&mut self) -> Vec<PathPreviewUpdate> {
        self.dead = true;
        self.stack.clear();
        self.token = None;
        self.path_key = false;
        self.preview
            .take()
            .map(|_| vec![PathPreviewUpdate::Clear])
            .unwrap_or_default()
    }

    fn character(&mut self, ch: char, updates: &mut Vec<PathPreviewUpdate>) -> bool {
        if let Some(token) = self.token.take() {
            match token {
                Token::String(mut token) => {
                    if matches!(token.escape, Escape::Normal) && ch == '"' {
                        match token.role {
                            StringRole::Key => {
                                self.path_key = self.stack.len() == 1 && token.text == "file_path";
                                if self.path_key {
                                    if self.seen_path {
                                        return false;
                                    }
                                    self.seen_path = true;
                                }
                                *self.stack.last_mut().unwrap() = Frame::Object(KeyState::Colon);
                            }
                            StringRole::Path => {
                                updates.push(PathPreviewUpdate::Set(token.text.clone()));
                                self.preview = Some(token.text);
                            }
                            StringRole::Ignore => {}
                        }
                        return true;
                    }
                    if !token.character(ch) {
                        return false;
                    }
                    self.token = Some(Token::String(token));
                    return true;
                }
                Token::Scalar(mut text) => {
                    if whitespace(ch) || matches!(ch, ',' | ']' | '}') {
                        if !matches!(
                            serde_json::from_str::<serde_json::Value>(&text),
                            Ok(serde_json::Value::Number(_)
                                | serde_json::Value::Bool(_)
                                | serde_json::Value::Null)
                        ) {
                            return false;
                        }
                    } else {
                        if text.len() + ch.len_utf8() > MAX_TOKEN {
                            return false;
                        }
                        text.push(ch);
                        self.token = Some(Token::Scalar(text));
                        return true;
                    }
                }
            }
        }
        if whitespace(ch) {
            return true;
        }
        if !self.started {
            if ch != '{' {
                return false;
            }
            self.started = true;
            self.stack.push(Frame::Object(KeyState::First));
            return true;
        }
        let Some(frame) = self.stack.last().copied() else {
            return false;
        };
        match frame {
            Frame::Object(KeyState::First | KeyState::Key) => {
                if ch == '}' && matches!(frame, Frame::Object(KeyState::First)) {
                    self.stack.pop();
                } else if ch == '"' {
                    self.string(StringRole::Key);
                } else {
                    return false;
                }
            }
            Frame::Object(KeyState::Colon) => {
                if ch != ':' {
                    return false;
                }
                *self.stack.last_mut().unwrap() = Frame::Object(KeyState::Value);
            }
            Frame::Object(KeyState::End) => match ch {
                ',' => *self.stack.last_mut().unwrap() = Frame::Object(KeyState::Key),
                '}' => {
                    self.stack.pop();
                }
                _ => return false,
            },
            Frame::Array(ValueState::End) => match ch {
                ',' => *self.stack.last_mut().unwrap() = Frame::Array(ValueState::Value),
                ']' => {
                    self.stack.pop();
                }
                _ => return false,
            },
            Frame::Array(ValueState::First) if ch == ']' => {
                self.stack.pop();
            }
            Frame::Object(KeyState::Value)
            | Frame::Array(ValueState::First | ValueState::Value) => {
                let path = self.stack.len() == 1 && self.path_key;
                self.path_key = false;
                if path && ch != '"' {
                    return false;
                }
                *self.stack.last_mut().unwrap() = match frame {
                    Frame::Object(_) => Frame::Object(KeyState::End),
                    Frame::Array(_) => Frame::Array(ValueState::End),
                };
                match ch {
                    '"' => self.string(if path {
                        StringRole::Path
                    } else {
                        StringRole::Ignore
                    }),
                    '{' | '[' => {
                        if self.stack.len() == MAX_DEPTH {
                            return false;
                        }
                        self.stack.push(if ch == '{' {
                            Frame::Object(KeyState::First)
                        } else {
                            Frame::Array(ValueState::First)
                        });
                    }
                    '-' | '0'..='9' | 't' | 'f' | 'n' => {
                        self.token = Some(Token::Scalar(ch.to_string()))
                    }
                    _ => return false,
                }
            }
        }
        true
    }

    fn string(&mut self, role: StringRole) {
        self.token = Some(Token::String(StringToken {
            role,
            text: String::new(),
            escape: Escape::Normal,
            high: None,
        }));
    }
}

fn whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r')
}

impl StringToken {
    fn character(&mut self, ch: char) -> bool {
        let decoded = match self.escape {
            Escape::Normal => match ch {
                '\\' => {
                    self.escape = Escape::Slash;
                    return true;
                }
                '\0'..='\u{1f}' => return false,
                _ => ch,
            },
            Escape::Slash => {
                self.escape = Escape::Normal;
                match ch {
                    '"' | '\\' | '/' => ch,
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'u' => {
                        self.escape = Escape::Hex(0, 0);
                        return true;
                    }
                    _ => return false,
                }
            }
            Escape::LowSlash => {
                if ch != '\\' {
                    return false;
                }
                self.escape = Escape::LowU;
                return true;
            }
            Escape::LowU => {
                if ch != 'u' {
                    return false;
                }
                self.escape = Escape::Hex(0, 0);
                return true;
            }
            Escape::Hex(value, digits) => {
                let Some(digit) = ch.to_digit(16) else {
                    return false;
                };
                let value = value * 16 + digit as u16;
                if digits < 3 {
                    self.escape = Escape::Hex(value, digits + 1);
                    return true;
                }
                self.escape = Escape::Normal;
                let code = if let Some(high) = self.high.take() {
                    if !(0xdc00..=0xdfff).contains(&value) {
                        return false;
                    }
                    0x10000 + ((high as u32 - 0xd800) << 10) + (value as u32 - 0xdc00)
                } else if (0xd800..=0xdbff).contains(&value) {
                    self.high = Some(value);
                    self.escape = Escape::LowSlash;
                    return true;
                } else {
                    value as u32
                };
                let Some(decoded) = char::from_u32(code) else {
                    return false;
                };
                decoded
            }
        };
        if !matches!(self.role, StringRole::Ignore) {
            if self.text.len() + decoded.len_utf8() > MAX_STRING {
                return false;
            }
            self.text.push(decoded);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn emits_closed_top_level_path() {
        let mut p = PathPreviewProbe::new("write");
        assert_eq!(
            p.push(r#"{"file_path":"a.rs""#),
            vec![PathPreviewUpdate::Set("a.rs".into())]
        );
    }

    fn scan(input: &str, chars: bool) -> (PathPreviewProbe, Vec<PathPreviewUpdate>) {
        let mut p = PathPreviewProbe::new("edit");
        let mut out = vec![];
        if chars {
            for ch in input.chars() {
                out.extend(p.push(&ch.to_string()));
            }
        } else {
            out.extend(p.push(input));
        }
        (p, out)
    }

    #[test]
    fn all_character_and_two_chunk_boundaries() {
        let input = r#"{"content":[null,true,false,-12.3e+4,{"file_path":"fake"}],"file_\u0070ath":"\\\\server\\share\\\uD83D\uDE00.txt"}"#;
        let value: serde_json::Value = serde_json::from_str(input).unwrap();
        let expected = vec![PathPreviewUpdate::Set(
            value["file_path"].as_str().unwrap().into(),
        )];
        for (i, _) in input.char_indices() {
            let mut p = PathPreviewProbe::new("write");
            let mut out = p.push(&input[..i]);
            out.extend(p.push(&input[i..]));
            assert_eq!(out, expected, "split {i}");
            assert_eq!(p.finish(&value), (true, vec![PathPreviewUpdate::Clear]));
            assert!(p.push(input).is_empty());
        }
        let (mut p, out) = scan(input, true);
        assert_eq!(out, expected);
        assert!(p.finish(&value).0);
    }

    #[test]
    fn long_body_is_not_retained_and_late_path_works() {
        let mut p = PathPreviewProbe::new("write");
        p.push("{\"content\":\"");
        for _ in 0..100 {
            assert!(p.push(&"x".repeat(4096)).is_empty());
        }
        let Some(Token::String(token)) = &p.token else {
            panic!()
        };
        assert!(token.text.is_empty());
        assert_eq!(
            p.push("\",\"file_path\":\"晚😀\"}"),
            vec![PathPreviewUpdate::Set("晚😀".into())]
        );
        assert!(p.finish(&serde_json::json!({"file_path":"晚😀"})).0);
    }

    #[test]
    fn rejects_duplicate_nested_and_invalid_syntax() {
        for input in [
            r#"{"file_path":"a","file_path":"a"}"#,
            r#"{"file_path":"a","file_\u0070ath":"b"}"#,
            r#"{"file_path":"a",}"#,
            r#"{"file_path":"a"}x"#,
            r#"{"file_path":"a","v":[1,]}"#,
            r#"{"file_path":"a","v":01}"#,
            r#"{"file_path":"a","v":true false}"#,
            r#"{"file_path":"a" "x":2}"#,
            r#"{"file_path":"a","v":"\q"}"#,
            r#"{"file_path":"a","v":"\uDC00"}"#,
            r#"{"file_path":"a","v":"\uD800x"}"#,
            r#"{"file_path":"a","v":"\uD800\u0000"}"#,
            r#"{"file_path":"a","v":"\uZZZZ"}"#,
            r#"{"file_path":"a","v":NaN}"#,
        ] {
            for chars in [false, true] {
                let (mut p, out) = scan(input, chars);
                assert_eq!(
                    out,
                    vec![PathPreviewUpdate::Set("a".into()), PathPreviewUpdate::Clear],
                    "{input}"
                );
                assert!(p.dead);
                assert!(p.push(r#"{"file_path":"revive"}"#).is_empty());
                assert!(p.invalidate().is_empty());
            }
        }
        let (mut p, out) = scan(
            r#"{"nested":{"file_path":"fake"},"array":[{"file_path":"fake"}]}"#,
            true,
        );
        assert!(out.is_empty());
        assert!(p.finish(&serde_json::json!({})).0);
        for input in [
            r#"{"file_path":4}"#,
            r#"{"file_path":"\uD800"}"#,
            r#"{"a" 2}"#,
            "[]",
        ] {
            let (p, out) = scan(input, true);
            assert!(p.dead, "{input}");
            assert!(out.is_empty());
        }
    }

    #[test]
    fn truncation_mismatch_cancel_and_unknown_tools() {
        for input in [
            r#"{"file_path":"a""#,
            r#"{"file_path":"a","x":"\uD8"#,
            r#"{"file_path":"a","x":tru"#,
        ] {
            let (mut p, _) = scan(input, true);
            assert_eq!(
                p.finish(&serde_json::json!({"file_path":"a"})),
                (false, vec![PathPreviewUpdate::Clear])
            );
        }
        let (mut p, _) = scan(r#"{"file_path":"a"}"#, false);
        assert_eq!(
            p.finish(&serde_json::json!({"file_path":"b"})),
            (false, vec![PathPreviewUpdate::Clear])
        );
        let (mut p, _) = scan(r#"{"file_path":"a""#, false);
        assert_eq!(p.invalidate(), vec![PathPreviewUpdate::Clear]);
        assert!(p.invalidate().is_empty());
        for tool in ["Write", "Edit", "read", "", "apply_patch"] {
            assert!(
                PathPreviewProbe::new(tool)
                    .push(r#"{"file_path":"a"}"#)
                    .is_empty()
            );
        }
    }

    #[test]
    fn budgets_fail_closed() {
        for tail in [
            format!(",\"body\":\"{}", "x".repeat(MAX_BYTES)),
            format!(",\"body\":{}", "[".repeat(MAX_DEPTH)),
            format!(",\"{}", "k".repeat(MAX_STRING + 1)),
            format!(",\"v\":{}", "1".repeat(MAX_TOKEN + 1)),
        ] {
            let (mut p, _) = scan(r#"{"file_path":"a""#, false);
            assert_eq!(p.push(&tail), vec![PathPreviewUpdate::Clear]);
            assert!(p.dead);
        }
        let (p, out) = scan(
            &format!("{{\"file_path\":\"{}\"}}", "😀".repeat(MAX_STRING / 4 + 1)),
            true,
        );
        assert!(p.dead);
        assert!(out.is_empty());
        let (mut p, out) = scan(
            &format!("{{\"file_path\":\"{}\"}}", "😀".repeat(MAX_STRING / 4)),
            true,
        );
        assert_eq!(out.len(), 1);
        assert!(!p.dead);
        assert_eq!(p.invalidate(), vec![PathPreviewUpdate::Clear]);
    }
}
