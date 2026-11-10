//! Resume a structural scan without retaining source strings or re-reading preceding payloads.
use anyhow::{Result, ensure};
use kcoder_state::external_history::ExternalHistoryReader;
use kcoder_types::imported_transcript::{HistoricalValueEncoding, HistoricalValueRef};
use serde::{Deserialize, Serialize};

pub const MIN_SCAN_BYTES: usize = 256;
pub const MAX_SCAN_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CURSOR_BYTES: usize = 4096;
const WINDOW: usize = 64 * 1024;
const STRUCTURE_WINDOW: usize = 64;
const SMALL_STRING: u64 = 128;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Root,
    RootKey,
    RootColon,
    RootValue,
    RootAfter,
    ArrayValue,
    ArrayAfter,
    ItemKey,
    ItemColon,
    ItemValue,
    ItemAfter,
    Done,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Key {
    Other,
    Content,
    Type,
    Text,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Unknown,
    Text,
    Excluded,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Capture {
    Ignore,
    RootKey,
    ItemKey,
    Type,
    Text,
    UnknownItem,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    String,
    Container,
    Atom,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Span {
    start: u64,
    end: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    start: u64,
    mode: Mode,
    depth: u16,
    string: bool,
    escaped: bool,
    finished: bool,
    capture: Capture,
    after: Phase,
}

/// Only structural state and original encoded coordinates; no key, type or body text is retained.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypedPartsCursor {
    record: u64,
    parent_offset: u64,
    parent_bytes: u64,
    offset: u64,
    phase: Phase,
    array_return: Phase,
    array_seen: bool,
    index: u64,
    key: Key,
    kind: Kind,
    text: Option<Span>,
    token: Option<Token>,
}

pub struct TypedTextPart {
    pub source_index: u64,
    pub value: HistoricalValueRef,
}
pub struct TypedPartsPage {
    pub part: Option<TypedTextPart>,
    pub next: Option<TypedPartsCursor>,
    pub read_bytes: u64,
    /// New unsupported items encountered by this call, not a cumulative count.
    pub unsupported_count: u64,
    /// New known attachments or opaque items encountered by this call.
    pub excluded_count: u64,
}

/// Request-owned plaintext cache, never a persisted or serialized cursor component.
#[derive(Default)]
pub struct TypedPartsCache {
    binding: Option<CacheBinding>,
    base: u64,
    buffer: Vec<u8>,
}
#[derive(PartialEq, Eq)]
struct CacheBinding {
    archive_id: String,
    snapshot_sha256: String,
    record_sha256: String,
    record: u64,
    parent_offset: u64,
    parent_bytes: u64,
}

struct Reader<'a, F> {
    archive: &'a ExternalHistoryReader,
    parent: &'a HistoricalValueRef,
    offset: u64,
    fetched: usize,
    budget: usize,
    base: u64,
    buffer: Vec<u8>,
    window: usize,
    adaptive: bool,
    check: F,
}
impl<F: FnMut(u64) -> bool> Reader<'_, F> {
    fn peek(&mut self) -> Result<Option<u8>> {
        if self.offset == self.parent.bytes {
            return Ok(None);
        }
        if self.offset < self.base || self.offset - self.base >= self.buffer.len() as u64 {
            let limit = self
                .window
                .min(self.budget - self.fetched)
                .min((self.parent.bytes - self.offset) as usize);
            if limit == 0 {
                return Ok(None);
            }
            ensure!((self.check)(self.offset), "history_search_cancelled");
            self.buffer = self.archive.read_record_chunk(
                self.parent.record,
                self.parent.offset + self.offset,
                limit,
            )?;
            ensure!(
                self.buffer.len() == limit,
                "history_search_structured_source_changed"
            );
            self.base = self.offset;
            self.fetched += limit;
        }
        Ok(Some(self.buffer[(self.offset - self.base) as usize]))
    }
    fn take(&mut self) -> Result<Option<u8>> {
        let byte = self.peek()?;
        if byte.is_some() {
            self.offset += 1;
            if self.offset.is_multiple_of(4096) {
                ensure!((self.check)(self.offset), "history_search_cancelled");
            }
        }
        Ok(byte)
    }
    fn small(&mut self, span: Span) -> Result<Small> {
        let width = span.end - span.start;
        if width > SMALL_STRING {
            return Ok(Small::Text(None));
        }
        // The token might already be inside the held window; avoid extra authenticated I/O.
        let local = span.start >= self.base && span.end <= self.base + self.buffer.len() as u64;
        if !local && width as usize > self.budget - self.fetched {
            return Ok(Small::Paused);
        }
        let owned;
        let bytes = if local {
            &self.buffer[(span.start - self.base) as usize..(span.end - self.base) as usize]
        } else {
            ensure!((self.check)(self.offset), "history_search_cancelled");
            owned = self.archive.read_record_chunk(
                self.parent.record,
                self.parent.offset + span.start,
                width as usize,
            )?;
            self.fetched += width as usize;
            owned.as_slice()
        };
        let value = serde_json::from_slice::<String>(bytes)
            .map_err(|_| anyhow::anyhow!("history_search_invalid_structured_json"))?;
        Ok(Small::Text(Some(value)))
    }
}
enum Small {
    Paused,
    Text(Option<String>),
}

fn begin<F: FnMut(u64) -> bool>(
    reader: &mut Reader<'_, F>,
    cursor: &mut TypedPartsCursor,
    capture: Capture,
    after: Phase,
) -> Result<()> {
    if reader.adaptive {
        reader.window = STRUCTURE_WINDOW;
    }
    let start = reader.offset;
    let byte = reader
        .take()?
        .ok_or_else(|| anyhow::anyhow!("history_search_invalid_structured_json"))?;
    let (mode, depth, string) = match byte {
        b'"' => (Mode::String, 0, true),
        b'{' | b'[' => (Mode::Container, 1, false),
        b'-' | b'0'..=b'9' | b't' | b'f' | b'n' => (Mode::Atom, 0, false),
        _ => anyhow::bail!("history_search_invalid_structured_json"),
    };
    cursor.token = Some(Token {
        start,
        mode,
        depth,
        string,
        escaped: false,
        finished: false,
        capture,
        after,
    });
    Ok(())
}

fn skip<F: FnMut(u64) -> bool>(reader: &mut Reader<'_, F>, token: &mut Token) -> Result<bool> {
    while !token.finished {
        if reader.adaptive && reader.offset - token.start >= 512 {
            reader.window = WINDOW;
        }
        let Some(byte) = reader.peek()? else {
            if reader.offset == reader.parent.bytes && token.mode == Mode::Atom {
                token.finished = true;
                break;
            }
            ensure!(
                reader.offset != reader.parent.bytes,
                "history_search_invalid_structured_json"
            );
            return Ok(false);
        };
        if token.mode == Mode::Atom
            && (byte.is_ascii_whitespace() || matches!(byte, b',' | b']' | b'}'))
        {
            token.finished = true;
            break;
        }
        reader.take()?;
        if token.string {
            if token.escaped {
                token.escaped = false;
            } else if byte == b'\\' {
                token.escaped = true;
            } else if byte == b'"' {
                token.string = false;
                if token.mode == Mode::String {
                    token.finished = true;
                }
            }
        } else if token.mode == Mode::Container {
            match byte {
                b'"' => token.string = true,
                b'[' | b'{' => {
                    token.depth += 1;
                    ensure!(
                        token.depth <= 128,
                        "history_search_structured_depth_exceeded"
                    );
                }
                b']' | b'}' => {
                    token.depth -= 1;
                    if token.depth == 0 {
                        token.finished = true;
                    }
                }
                _ => {}
            }
        }
    }
    Ok(true)
}

fn classify(value: Option<&str>) -> Kind {
    match value {
        Some("text" | "input_text" | "output_text") => Kind::Text,
        Some(
            "image" | "image_url" | "input_image" | "output_image" | "document" | "input_file"
            | "file" | "encrypted_content" | "thinking" | "redacted_thinking" | "signature",
        ) => Kind::Excluded,
        _ => Kind::Unknown,
    }
}

fn finish<F: FnMut(u64) -> bool>(
    reader: &mut Reader<'_, F>,
    cursor: &mut TypedPartsCursor,
    unsupported: &mut u64,
) -> Result<bool> {
    let token = cursor.token.as_ref().unwrap();
    let span = Span {
        start: token.start,
        end: reader.offset,
    };
    let small = if matches!(
        token.capture,
        Capture::RootKey | Capture::ItemKey | Capture::Type
    ) {
        match reader.small(span)? {
            Small::Paused => return Ok(false),
            Small::Text(value) => value,
        }
    } else {
        None
    };
    match token.capture {
        Capture::RootKey => {
            cursor.key = if small.as_deref() == Some("content") {
                Key::Content
            } else {
                Key::Other
            }
        }
        Capture::ItemKey => {
            cursor.key = match small.as_deref() {
                Some("type") => Key::Type,
                Some("text") => Key::Text,
                _ => Key::Other,
            }
        }
        Capture::Type => cursor.kind = classify(small.as_deref()),
        Capture::Text => cursor.text = Some(span),
        Capture::UnknownItem => *unsupported += 1,
        Capture::Ignore => {}
    }
    cursor.phase = token.after;
    cursor.token = None;
    if reader.adaptive {
        reader.window = STRUCTURE_WINDOW;
    }
    Ok(true)
}

/// Read direct typed text children only. Already normalized parent JSON and every source
/// window are authenticated by the archive; no JSON-looking string is interpreted again.
/// `read_bytes` includes prefetch and tiny key/type rereads and never exceeds `budget`.
pub fn next_text(
    archive: &ExternalHistoryReader,
    parent: &HistoricalValueRef,
    cursor: Option<TypedPartsCursor>,
    budget: usize,
    check: impl FnMut(u64) -> bool,
) -> Result<TypedPartsPage> {
    scan(
        archive,
        parent,
        cursor,
        budget,
        check,
        &mut TypedPartsCache::default(),
        true,
    )
}

/// Reuse one authenticated source window across short items in the same native request.
pub fn next_text_cached(
    archive: &ExternalHistoryReader,
    parent: &HistoricalValueRef,
    cursor: Option<TypedPartsCursor>,
    budget: usize,
    cache: &mut TypedPartsCache,
    check: impl FnMut(u64) -> bool,
) -> Result<TypedPartsPage> {
    scan(archive, parent, cursor, budget, check, cache, false)
}

fn scan(
    archive: &ExternalHistoryReader,
    parent: &HistoricalValueRef,
    cursor: Option<TypedPartsCursor>,
    budget: usize,
    check: impl FnMut(u64) -> bool,
    cache: &mut TypedPartsCache,
    adaptive: bool,
) -> Result<TypedPartsPage> {
    ensure!(
        (MIN_SCAN_BYTES..=MAX_SCAN_BYTES).contains(&budget),
        "history_search_invalid_scan_budget"
    );
    ensure!(
        parent.encoding == HistoricalValueEncoding::Json,
        "history_search_structured_parent_required"
    );
    let record = archive
        .records(parent.record, 1)?
        .records
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("history_search_record_not_found"))?;
    ensure!(
        parent
            .offset
            .checked_add(parent.bytes)
            .is_some_and(|end| end <= record.bytes),
        "history_search_invalid_structured_parent"
    );
    let mut cursor = cursor.unwrap_or(TypedPartsCursor {
        record: parent.record,
        parent_offset: parent.offset,
        parent_bytes: parent.bytes,
        offset: 0,
        phase: Phase::Root,
        array_return: Phase::Done,
        array_seen: false,
        index: 0,
        key: Key::Other,
        kind: Kind::Unknown,
        text: None,
        token: None,
    });
    ensure!(
        cursor.record == parent.record
            && cursor.parent_offset == parent.offset
            && cursor.parent_bytes == parent.bytes
            && cursor.offset <= parent.bytes,
        "history_search_invalid_typed_cursor"
    );
    ensure!(
        cursor
            .text
            .is_none_or(|span| span.start < span.end && span.end <= cursor.offset)
            && cursor
                .token
                .as_ref()
                .is_none_or(|token| token.start < cursor.offset
                    && token.depth <= 128
                    && (token.mode != Mode::Container || token.finished || token.depth > 0)),
        "history_search_invalid_typed_cursor"
    );
    ensure!(
        serde_json::to_vec(&cursor)?.len() <= MAX_CURSOR_BYTES,
        "history_search_invalid_typed_cursor"
    );
    let receipt = archive
        .receipt()?
        .ok_or_else(|| anyhow::anyhow!("history_search_structured_source_changed"))?;
    let binding = CacheBinding {
        archive_id: receipt.archive_id,
        snapshot_sha256: receipt.snapshot_sha256,
        record_sha256: record.sha256,
        record: parent.record,
        parent_offset: parent.offset,
        parent_bytes: parent.bytes,
    };
    if cache.binding.as_ref() != Some(&binding) {
        cache.binding = Some(binding);
        cache.buffer.clear();
        cache.base = cursor.offset;
    }
    let mut reader = Reader {
        archive,
        parent,
        offset: cursor.offset,
        fetched: 0,
        budget,
        base: cache.base,
        buffer: std::mem::take(&mut cache.buffer),
        window: if adaptive { STRUCTURE_WINDOW } else { WINDOW },
        adaptive,
        check,
    };
    let (mut part, mut unsupported, mut excluded) = (None, 0, 0);
    loop {
        ensure!((reader.check)(reader.offset), "history_search_cancelled");
        if let Some(mut token) = cursor.token.take() {
            let complete = skip(&mut reader, &mut token)?;
            cursor.token = Some(token);
            if !complete || !finish(&mut reader, &mut cursor, &mut unsupported)? {
                break;
            }
            continue;
        }
        if cursor.phase == Phase::Done {
            break;
        }
        let Some(byte) = reader.peek()? else {
            ensure!(
                reader.offset < parent.bytes,
                "history_search_invalid_structured_json"
            );
            break;
        };
        if byte.is_ascii_whitespace() {
            reader.take()?;
            continue;
        }
        match cursor.phase {
            Phase::Root => match byte {
                b'[' => {
                    reader.take()?;
                    cursor.array_seen = true;
                    cursor.array_return = Phase::Done;
                    cursor.phase = Phase::ArrayValue;
                }
                b'{' => {
                    reader.take()?;
                    cursor.phase = Phase::RootKey;
                }
                _ => begin(&mut reader, &mut cursor, Capture::Ignore, Phase::Done)?,
            },
            Phase::RootKey | Phase::ItemKey => {
                if byte == b'}' {
                    reader.take()?;
                    if cursor.phase == Phase::RootKey {
                        cursor.phase = Phase::Done;
                    } else {
                        cursor.phase = Phase::ArrayAfter;
                        match (cursor.kind, cursor.text.take()) {
                            (Kind::Text, Some(span)) => {
                                part = Some(TypedTextPart {
                                    source_index: cursor.index,
                                    value: HistoricalValueRef {
                                        record: parent.record,
                                        offset: parent.offset + span.start,
                                        bytes: span.end - span.start,
                                        encoding: HistoricalValueEncoding::JsonString,
                                        decoded_bytes: None,
                                        decoded_sha256: None,
                                        preview: None,
                                    },
                                });
                                break;
                            }
                            (Kind::Excluded, _) => excluded += 1,
                            _ => unsupported += 1,
                        }
                    }
                } else {
                    ensure!(byte == b'"', "history_search_invalid_structured_json");
                    let root = cursor.phase == Phase::RootKey;
                    begin(
                        &mut reader,
                        &mut cursor,
                        if root {
                            Capture::RootKey
                        } else {
                            Capture::ItemKey
                        },
                        if root {
                            Phase::RootColon
                        } else {
                            Phase::ItemColon
                        },
                    )?;
                }
            }
            Phase::RootColon | Phase::ItemColon => {
                ensure!(
                    reader.take()? == Some(b':'),
                    "history_search_invalid_structured_json"
                );
                cursor.phase = if cursor.phase == Phase::RootColon {
                    Phase::RootValue
                } else {
                    Phase::ItemValue
                };
            }
            Phase::RootValue => {
                if cursor.key == Key::Content && byte == b'[' {
                    reader.take()?;
                    cursor.array_seen = true;
                    cursor.array_return = Phase::RootAfter;
                    cursor.phase = Phase::ArrayValue;
                    cursor.index = 0;
                } else {
                    begin(&mut reader, &mut cursor, Capture::Ignore, Phase::RootAfter)?;
                }
            }
            Phase::ItemValue => {
                let capture = if byte == b'"' {
                    match cursor.key {
                        Key::Type => Capture::Type,
                        Key::Text => Capture::Text,
                        _ => Capture::Ignore,
                    }
                } else {
                    Capture::Ignore
                };
                begin(&mut reader, &mut cursor, capture, Phase::ItemAfter)?;
            }
            Phase::ArrayValue => {
                if byte == b']' {
                    reader.take()?;
                    cursor.phase = cursor.array_return;
                } else if byte == b'{' {
                    reader.take()?;
                    cursor.kind = Kind::Unknown;
                    cursor.text = None;
                    cursor.phase = Phase::ItemKey;
                } else {
                    begin(
                        &mut reader,
                        &mut cursor,
                        Capture::UnknownItem,
                        Phase::ArrayAfter,
                    )?;
                }
            }
            Phase::ArrayAfter | Phase::RootAfter | Phase::ItemAfter => {
                let (close, more, done) = match cursor.phase {
                    Phase::ArrayAfter => (b']', Phase::ArrayValue, cursor.array_return),
                    Phase::RootAfter => (b'}', Phase::RootKey, Phase::Done),
                    Phase::ItemAfter => (b'}', Phase::ItemKey, Phase::ItemKey),
                    _ => unreachable!(),
                };
                if byte == b',' {
                    reader.take()?;
                    if cursor.phase == Phase::ArrayAfter {
                        cursor.index = cursor.index.checked_add(1).ok_or_else(|| {
                            anyhow::anyhow!("history_search_structured_item_budget_exceeded")
                        })?;
                    }
                    cursor.phase = more;
                } else {
                    ensure!(byte == close, "history_search_invalid_structured_json");
                    if cursor.phase == Phase::ItemAfter {
                        cursor.phase = Phase::ItemKey;
                    } else {
                        reader.take()?;
                        cursor.phase = done;
                    }
                }
            }
            Phase::Done => unreachable!(),
        }
    }
    cursor.offset = reader.offset;
    let next = if cursor.phase == Phase::Done {
        if !cursor.array_seen {
            unsupported += 1;
        }
        None
    } else {
        Some(cursor)
    };
    let read_bytes = reader.fetched as u64;
    cache.base = reader.base;
    cache.buffer = reader.buffer;
    Ok(TypedPartsPage {
        part,
        next,
        read_bytes,
        unsupported_count: unsupported,
        excluded_count: excluded,
    })
}
