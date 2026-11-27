use super::*;
use crate::history_search::{NativeSearchHit, SEARCH_READ_BYTES, SearchWork};
use kcoder_types::historical_search::HistoricalSearchMatch;

fn read_cost(chunk: &HistoricalTextChunk, offset: u64) -> u64 {
    let quoted = chunk.encoding == HistoricalValueEncoding::JsonString;
    let start = if quoted { offset.max(1) } else { offset };
    chunk
        .next_offset
        .unwrap_or(chunk.source_bytes - u64::from(quoted))
        - start
}

pub(crate) fn scan_record(
    archive: &ExternalHistoryReader,
    record: &HistoricalRecord,
    work: &mut SearchWork<'_>,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    let mut overlap: Option<(u64, String)> = None;
    let mut typed_cache = crate::history_search::typed_parts::TypedPartsCache::default();
    let total = u32::try_from(count(record)).context("history_search_block_budget_exceeded")?;
    ensure!(work.cursor.block <= total, "history_search_invalid_cursor");
    while work.cursor.block < total && !work.stopped() {
        ensure!(
            check(work.cursor.processed_bytes),
            "history_search_cancelled"
        );
        // Reserve two windows: one may be required to reconstruct overlap after resuming.
        if work.bytes + 2 * 64 * 1024 > SEARCH_READ_BYTES {
            work.paused = true;
            break;
        }
        work.steps += 1;
        let index = work.cursor.block;
        let selected = block(record, index)?;
        if !selected.available() {
            work.cursor.excluded += 1;
            work.next_block();
            continue;
        }
        let structured = selected.kind == HistoricalDisplayBlockKind::ToolResult
            && selected.value.encoding == HistoricalValueEncoding::Json;
        if structured && work.cursor.typed_value.is_none() {
            if work.cursor.typed_done {
                work.next_block();
                continue;
            }
            let remaining = (SEARCH_READ_BYTES - work.bytes) as usize;
            if remaining < crate::history_search::typed_parts::MIN_SCAN_BYTES {
                work.paused = true;
                break;
            }
            let part = crate::history_search::typed_parts::next_text_cached(
                archive,
                selected.value,
                work.cursor.typed_cursor.take(),
                remaining,
                &mut typed_cache,
                &mut *check,
            )?;
            work.charge(part.read_bytes)?;
            work.cursor.unsupported += part.unsupported_count;
            work.cursor.excluded += part.excluded_count;
            work.cursor.typed_done = part.next.is_none();
            work.cursor.typed_cursor = part.next;
            work.cursor.typed_value = part.part.map(|part| part.value);
            if work.cursor.typed_value.is_none() {
                if work.cursor.typed_done {
                    work.next_block()
                } else {
                    work.paused = true
                }
                continue;
            }
            work.cursor.offset = 0;
            work.cursor.previous_offset = None;
            overlap = None;
        }
        if work.bytes + 2 * 64 * 1024 > SEARCH_READ_BYTES {
            work.paused = true;
            break;
        }
        let text_value = work.cursor.typed_value.clone();
        let value = text_value.as_ref().unwrap_or(selected.value);
        let offset = work.cursor.offset;
        let mut combined = String::new();
        let mut body_start = offset;
        if let Some(previous) = work.cursor.previous_offset {
            ensure!(previous < offset, "history_search_invalid_cursor");
            if let Some((cached_offset, cached)) = overlap.take() {
                ensure!(cached_offset == previous, "history_search_invalid_cursor");
                combined = cached;
            } else {
                let chunk = text::read(archive, record.record, value, previous, &mut *check)?;
                ensure!(
                    chunk.next_offset == Some(offset),
                    "history_search_invalid_cursor"
                );
                work.charge(read_cost(&chunk, previous))?;
                combined = chunk
                    .text
                    .chars()
                    .rev()
                    .take(work.needle.overlap_chars)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
            body_start = previous;
        }
        let prefix = combined.len();
        let chunk = text::read(archive, record.record, value, offset, &mut *check)?;
        work.charge(read_cost(&chunk, offset))?;
        combined.push_str(&chunk.text);
        if let Some((start, before, matched, after)) = work.needle.find(&combined) {
            let role = if let HistoricalRecordData::Message { role, .. } = &record.data {
                Some(*role)
            } else {
                None
            };
            let mut display = selected.display(index);
            let part = text_value
                .as_ref()
                .map(|value| crate::history_search::SearchTextRange {
                    offset: value.offset,
                    bytes: value.bytes,
                });
            if let Some(value) = &text_value {
                display.preview = None;
                display.source_bytes = value.bytes;
                display.decoded_bytes = value.decoded_bytes;
            }
            work.items.push(NativeSearchHit {
                body_start: if start < prefix { body_start } else { offset },
                part,
                found: HistoricalSearchMatch {
                    position: work.cursor.position,
                    record: record.record,
                    block: display,
                    role,
                    before,
                    matched,
                    after,
                },
            });
            overlap = None;
            work.next_block();
        } else if let Some(next) = chunk.next_offset {
            overlap = Some((
                offset,
                chunk
                    .text
                    .chars()
                    .rev()
                    .take(work.needle.overlap_chars)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect(),
            ));
            work.cursor.previous_offset = Some(offset);
            work.cursor.offset = next;
        } else {
            overlap = None;
            if structured {
                work.cursor.typed_value = None;
                work.cursor.offset = 0;
                work.cursor.previous_offset = None;
                if work.cursor.typed_done {
                    work.next_block()
                }
            } else {
                work.next_block()
            }
        }
    }
    if work.cursor.block == total {
        work.cursor.position += 1;
        work.cursor.block = 0;
        work.cursor.offset = 0;
        work.cursor.previous_offset = None;
    }
    Ok(())
}
impl HistoryArchiveView {
    pub fn text_part(
        &self,
        ordinal: u64,
        request: crate::history_search::SearchPartRead,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistoricalTextChunk> {
        let record = self.projection.record(ordinal)?;
        read_part(&self.archive, &record, request, check)
    }
    pub(crate) fn search_snapshot(&self) -> Result<(String, u64)> {
        let progress = self.projection.progress()?;
        ensure!(
            progress.normalization_complete,
            "history_search_normalization_incomplete"
        );
        Ok((self.content_identity(), progress.normalized_records))
    }
    pub(crate) fn scan_search_record(
        &self,
        work: &mut SearchWork<'_>,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let record = self.projection.record(work.cursor.position)?;
        scan_record(&self.archive, &record, work, check)
    }
}

/// Only authenticated host-issued ranges from the typed text scanner belong here.
pub(crate) fn read_part(
    archive: &ExternalHistoryReader,
    record: &HistoricalRecord,
    request: crate::history_search::SearchPartRead,
    check: impl FnMut(u64) -> bool,
) -> Result<HistoricalTextChunk> {
    let parent = block(record, request.block)?;
    ensure!(
        parent.kind == HistoricalDisplayBlockKind::ToolResult
            && parent.value.encoding == HistoricalValueEncoding::Json,
        "history_search_invalid_part"
    );
    let end = request
        .range
        .offset
        .checked_add(request.range.bytes)
        .context("history_search_invalid_part")?;
    let parent_end = parent
        .value
        .offset
        .checked_add(parent.value.bytes)
        .context("history_search_invalid_part")?;
    ensure!(
        request.range.offset >= parent.value.offset && end <= parent_end,
        "history_search_invalid_part"
    );
    let value = HistoricalValueRef {
        record: record.record,
        offset: request.range.offset,
        bytes: request.range.bytes,
        encoding: HistoricalValueEncoding::JsonString,
        decoded_bytes: None,
        decoded_sha256: None,
        preview: None,
    };
    text::read(archive, record.record, &value, request.offset, check)
}
