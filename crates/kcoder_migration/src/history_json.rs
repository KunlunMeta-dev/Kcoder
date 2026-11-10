//! Bounded JSON token locations for foreign transcripts; large strings remain archive references.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read},
};

const PREVIEW_BYTES: usize = 4096;
const KEY_BYTES: u64 = 4096;
const KEY_BUDGET: u64 = 1024 * 1024;
const NODE_BUDGET: u64 = 1_000_000;
const MAX_DEPTH: usize = 128;

#[cfg(test)]
#[path = "history_json_tests.rs"]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Segment {
    Key(String),
    Index(u64),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub start: u64,
    pub end: u64,
}
#[derive(Clone)]
pub(crate) struct Text {
    pub preview: String,
    pub bytes: u64,
    pub sha256: String,
    pub trimmed_head: String,
    pub trimmed_tail: String,
}
pub(crate) enum Value {
    String(Text),
    Number(String),
    Bool(bool),
    Null,
    Object,
    Array,
}
pub(crate) struct Node {
    pub span: Span,
    pub value: Value,
}

struct TextBuffer {
    preview: String,
    preview_truncated: bool,
    bytes: u64,
    hash: Sha256,
    pending: Vec<u8>,
    maximum: Option<u64>,
    edges: TextEdges,
}

#[derive(Default)]
struct TextEdges {
    head: String,
    tail: String,
    raw_tail: String,
    started: bool,
    head_truncated: bool,
    body_bytes: u64,
    nonwhite_end: u64,
}

fn suffix(before: &str, after: &str) -> String {
    let joined;
    let text = if after.len() >= 512 {
        after
    } else {
        joined = format!("{before}{after}");
        &joined
    };
    let mut start = text.len().saturating_sub(512);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

impl TextEdges {
    fn push(&mut self, text: &str) {
        let head = if self.started {
            text
        } else {
            text.trim_start()
        };
        let significant = head.trim_end();
        if !significant.is_empty() {
            self.nonwhite_end = self.body_bytes + significant.len() as u64;
        }
        self.body_bytes += head.len() as u64;
        if !head.is_empty() {
            self.started = true;
            if !self.head_truncated {
                let mut take = head.len().min(512usize.saturating_sub(self.head.len()));
                while !head.is_char_boundary(take) {
                    take -= 1;
                }
                self.head.push_str(&head[..take]);
                self.head_truncated = take < head.len();
            }
        }
        let trimmed = text.trim_end();
        if !trimmed.is_empty() {
            self.tail = suffix(&self.raw_tail, trimmed);
        }
        self.raw_tail = suffix(&self.raw_tail, text);
    }

    fn finish(mut self) -> (String, String) {
        // Only trim an edge when the last significant byte proves that the
        // whitespace is outside the body, rather than an interior prefix/suffix.
        if self.nonwhite_end < self.head.len() as u64 {
            self.head.truncate(self.nonwhite_end as usize);
        }
        if self.nonwhite_end < self.tail.len() as u64 {
            self.tail = self.tail[self.tail.len() - self.nonwhite_end as usize..].to_owned();
        }
        (self.head, self.tail)
    }
}
impl TextBuffer {
    fn new(maximum: Option<u64>) -> Self {
        Self {
            preview: String::new(),
            preview_truncated: false,
            bytes: 0,
            hash: Sha256::new(),
            pending: Vec::new(),
            maximum,
            edges: TextEdges::default(),
        }
    }
    fn valid(&mut self, text: &str) -> Result<()> {
        self.bytes += text.len() as u64;
        ensure!(
            self.maximum.is_none_or(|limit| self.bytes <= limit),
            "history_json_key_budget_exceeded"
        );
        self.hash.update(text.as_bytes());
        self.edges.push(text);
        if !self.preview_truncated {
            let mut take = text
                .len()
                .min(PREVIEW_BYTES.saturating_sub(self.preview.len()));
            while !text.is_char_boundary(take) {
                take -= 1;
            }
            self.preview.push_str(&text[..take]);
            // Once a character cannot fit, later input cannot be part of the prefix.
            self.preview_truncated = take < text.len();
        }
        Ok(())
    }
    fn utf8(&mut self, mut bytes: &[u8]) -> Result<()> {
        if !self.pending.is_empty() {
            let width = match self.pending[0] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => anyhow::bail!("history_json_invalid_utf8"),
            };
            let take = (width - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < width {
                return Ok(());
            }
            let pending = std::mem::take(&mut self.pending);
            self.valid(
                std::str::from_utf8(&pending)
                    .map_err(|_| anyhow::anyhow!("history_json_invalid_utf8"))?,
            )?;
        }
        match std::str::from_utf8(bytes) {
            Ok(text) => self.valid(text),
            Err(error) => {
                self.valid(std::str::from_utf8(&bytes[..error.valid_up_to()])?)?;
                ensure!(error.error_len().is_none(), "history_json_invalid_utf8");
                self.pending
                    .extend_from_slice(&bytes[error.valid_up_to()..]);
                Ok(())
            }
        }
    }
    fn character(&mut self, ch: char) -> Result<()> {
        ensure!(self.pending.is_empty(), "history_json_invalid_utf8");
        let mut bytes = [0; 4];
        self.valid(ch.encode_utf8(&mut bytes))
    }
    fn finish(self) -> Result<Text> {
        ensure!(self.pending.is_empty(), "history_json_invalid_utf8");
        let (trimmed_head, trimmed_tail) = self.edges.finish();
        Ok(Text {
            preview: self.preview,
            bytes: self.bytes,
            sha256: format!("{:x}", self.hash.finalize()),
            trimmed_head,
            trimmed_tail,
        })
    }
}

pub(crate) fn walk(
    reader: impl Read,
    visit: impl FnMut(&[Segment], Node) -> Result<()>,
    check: impl FnMut(u64) -> bool,
) -> Result<()> {
    let mut parser = Parser {
        reader: BufReader::with_capacity(64 * 1024, reader),
        visit,
        check,
        position: 0,
        nodes: 0,
        key_bytes: 0,
        path: Vec::new(),
        last_checked: 0,
    };
    parser.value(0)?;
    parser.space()?;
    ensure!(parser.peek()?.is_none(), "history_json_trailing_data");
    ensure!((parser.check)(parser.position), "history_json_cancelled");
    Ok(())
}

struct Parser<R, V, C> {
    reader: BufReader<R>,
    visit: V,
    check: C,
    position: u64,
    nodes: u64,
    key_bytes: u64,
    path: Vec<Segment>,
    last_checked: u64,
}
impl<R: Read, V: FnMut(&[Segment], Node) -> Result<()>, C: FnMut(u64) -> bool> Parser<R, V, C> {
    fn progress(&mut self) -> Result<()> {
        if self.position.saturating_sub(self.last_checked) >= 64 * 1024 || self.position == 0 {
            ensure!((self.check)(self.position), "history_json_cancelled");
            self.last_checked = self.position;
        }
        Ok(())
    }
    fn peek(&mut self) -> Result<Option<u8>> {
        self.progress()?;
        Ok(self.reader.fill_buf()?.first().copied())
    }
    fn byte(&mut self) -> Result<u8> {
        let byte = self
            .peek()?
            .ok_or_else(|| anyhow::anyhow!("history_json_incomplete"))?;
        self.reader.consume(1);
        self.position += 1;
        Ok(byte)
    }
    fn expect(&mut self, expected: u8) -> Result<()> {
        ensure!(self.byte()? == expected, "history_json_invalid_syntax");
        Ok(())
    }
    fn space(&mut self) -> Result<()> {
        while self
            .peek()?
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.byte()?;
        }
        Ok(())
    }
    fn emit(&mut self, start: u64, value: Value) -> Result<()> {
        (self.visit)(
            &self.path,
            Node {
                span: Span {
                    start,
                    end: self.position,
                },
                value,
            },
        )
    }
    fn value(&mut self, depth: usize) -> Result<()> {
        ensure!(depth <= MAX_DEPTH, "history_json_depth_exceeded");
        self.nodes += 1;
        ensure!(
            self.nodes <= NODE_BUDGET,
            "history_json_node_budget_exceeded"
        );
        self.space()?;
        let start = self.position;
        match self
            .peek()?
            .ok_or_else(|| anyhow::anyhow!("history_json_incomplete"))?
        {
            b'"' => {
                let text = self.string(None)?;
                self.emit(start, Value::String(text))
            }
            b'{' => self.object(start, depth),
            b'[' => self.array(start, depth),
            b't' => {
                self.literal(b"true")?;
                self.emit(start, Value::Bool(true))
            }
            b'f' => {
                self.literal(b"false")?;
                self.emit(start, Value::Bool(false))
            }
            b'n' => {
                self.literal(b"null")?;
                self.emit(start, Value::Null)
            }
            b'-' | b'0'..=b'9' => {
                let number = self.number()?;
                self.emit(start, Value::Number(number))
            }
            _ => anyhow::bail!("history_json_invalid_syntax"),
        }
    }
    fn object(&mut self, start: u64, depth: usize) -> Result<()> {
        self.expect(b'{')?;
        self.space()?;
        let mut keys = HashSet::new();
        if self.peek()? != Some(b'}') {
            loop {
                self.space()?;
                let key = self.string(Some(KEY_BYTES))?;
                self.key_bytes += key.bytes;
                ensure!(
                    self.key_bytes <= KEY_BUDGET,
                    "history_json_key_budget_exceeded"
                );
                ensure!(
                    keys.insert(key.preview.clone()),
                    "history_json_duplicate_key"
                );
                self.space()?;
                self.expect(b':')?;
                self.path.push(Segment::Key(key.preview));
                self.value(depth + 1)?;
                self.path.pop();
                self.space()?;
                match self.byte()? {
                    b'}' => return self.emit(start, Value::Object),
                    b',' => {}
                    _ => anyhow::bail!("history_json_invalid_syntax"),
                }
            }
        }
        self.expect(b'}')?;
        self.emit(start, Value::Object)
    }
    fn array(&mut self, start: u64, depth: usize) -> Result<()> {
        self.expect(b'[')?;
        self.space()?;
        let mut index = 0;
        if self.peek()? != Some(b']') {
            loop {
                self.path.push(Segment::Index(index));
                self.value(depth + 1)?;
                self.path.pop();
                index += 1;
                self.space()?;
                match self.byte()? {
                    b']' => return self.emit(start, Value::Array),
                    b',' => {}
                    _ => anyhow::bail!("history_json_invalid_syntax"),
                }
            }
        }
        self.expect(b']')?;
        self.emit(start, Value::Array)
    }
    fn literal(&mut self, text: &[u8]) -> Result<()> {
        for byte in text {
            self.expect(*byte)?;
        }
        Ok(())
    }
    fn number(&mut self) -> Result<String> {
        let mut result = Vec::new();
        while self
            .peek()?
            .is_some_and(|byte| matches!(byte, b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-'))
        {
            ensure!(result.len() < 128, "history_json_number_budget_exceeded");
            result.push(self.byte()?);
        }
        let mut cursor = usize::from(result.first() == Some(&b'-'));
        match result.get(cursor) {
            Some(b'0') => cursor += 1,
            Some(b'1'..=b'9') => {
                cursor += 1;
                while result.get(cursor).is_some_and(u8::is_ascii_digit) {
                    cursor += 1;
                }
            }
            _ => anyhow::bail!("history_json_invalid_number"),
        }
        if result.get(cursor) == Some(&b'.') {
            cursor += 1;
            let start = cursor;
            while result.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            ensure!(cursor > start, "history_json_invalid_number");
        }
        if result
            .get(cursor)
            .is_some_and(|byte| matches!(byte, b'e' | b'E'))
        {
            cursor += 1;
            if result
                .get(cursor)
                .is_some_and(|byte| matches!(byte, b'+' | b'-'))
            {
                cursor += 1;
            }
            let start = cursor;
            while result.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            ensure!(cursor > start, "history_json_invalid_number");
        }
        ensure!(cursor == result.len(), "history_json_invalid_number");
        Ok(String::from_utf8(result)?)
    }
    fn hex(&mut self) -> Result<u16> {
        let mut value = 0;
        for _ in 0..4 {
            let byte = self.byte()?;
            value = value * 16
                + match byte {
                    b'0'..=b'9' => u16::from(byte - b'0'),
                    b'a'..=b'f' => u16::from(byte - b'a' + 10),
                    b'A'..=b'F' => u16::from(byte - b'A' + 10),
                    _ => anyhow::bail!("history_json_invalid_escape"),
                };
        }
        Ok(value)
    }
    fn string(&mut self, maximum: Option<u64>) -> Result<Text> {
        self.expect(b'"')?;
        let mut text = TextBuffer::new(maximum);
        loop {
            self.progress()?;
            let available = self.reader.fill_buf()?;
            ensure!(!available.is_empty(), "history_json_incomplete");
            let count = available
                .iter()
                .position(|byte| *byte < 0x20 || matches!(byte, b'"' | b'\\'))
                .unwrap_or(available.len());
            if count > 0 {
                text.utf8(&available[..count])?;
                self.reader.consume(count);
                self.position += count as u64;
                continue;
            }
            match self.byte()? {
                b'"' => return text.finish(),
                b'\\' => match self.byte()? {
                    b'"' => text.character('"')?,
                    b'\\' => text.character('\\')?,
                    b'/' => text.character('/')?,
                    b'b' => text.character('\u{8}')?,
                    b'f' => text.character('\u{c}')?,
                    b'n' => text.character('\n')?,
                    b'r' => text.character('\r')?,
                    b't' => text.character('\t')?,
                    b'u' => {
                        let high = self.hex()?;
                        let value = if (0xd800..=0xdbff).contains(&high) {
                            self.expect(b'\\')?;
                            self.expect(b'u')?;
                            let low = self.hex()?;
                            ensure!(
                                (0xdc00..=0xdfff).contains(&low),
                                "history_json_invalid_surrogate"
                            );
                            0x10000 + ((u32::from(high) - 0xd800) << 10) + u32::from(low) - 0xdc00
                        } else {
                            u32::from(high)
                        };
                        text.character(
                            char::from_u32(value)
                                .ok_or_else(|| anyhow::anyhow!("history_json_invalid_surrogate"))?,
                        )?;
                    }
                    _ => anyhow::bail!("history_json_invalid_escape"),
                },
                _ => anyhow::bail!("history_json_unescaped_control"),
            }
        }
    }
}
