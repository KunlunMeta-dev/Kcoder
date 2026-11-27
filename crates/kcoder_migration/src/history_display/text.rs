//! Only native, normalized block references select body ranges; transports seal returned cursors.
use super::*;
const CHUNK: usize = 64 * 1024;

pub(crate) fn read(
    archive: &ExternalHistoryReader,
    ordinal: u64,
    value: &HistoricalValueRef,
    offset: u64,
    mut check: impl FnMut(u64) -> bool,
) -> Result<HistoricalTextChunk> {
    ensure!(check(0), "history_display_cancelled");
    ensure!(
        value.record == ordinal && offset <= value.bytes,
        "history_display_invalid_offset"
    );
    let total = archive
        .records(ordinal, 1)?
        .records
        .first()
        .context("history_display_record_not_found")?
        .bytes;
    ensure!(
        value
            .offset
            .checked_add(value.bytes)
            .is_some_and(|end| end <= total),
        "history_display_invalid_reference"
    );
    let quoted = value.encoding == HistoricalValueEncoding::JsonString;
    let (start, end) = if quoted {
        ensure!(
            value.bytes >= 2 && offset < value.bytes,
            "history_display_invalid_offset"
        );
        ensure!(
            archive.read_record_chunk(ordinal, value.offset, 1)? == b"\""
                && archive.read_record_chunk(ordinal, value.offset + value.bytes - 1, 1)? == b"\"",
            "history_display_invalid_reference"
        );
        (offset.max(1), value.bytes - 1)
    } else {
        (offset, value.bytes)
    };
    let available = (end - start).min((CHUNK + 12) as u64) as usize;
    let bytes = if available == 0 {
        Vec::new()
    } else {
        archive.read_record_chunk(ordinal, value.offset + start, available)?
    };
    let mut count = 0;
    while count < bytes.len() && count < CHUNK {
        if count % 4096 == 0 {
            ensure!(check(count as u64), "history_display_cancelled");
        }
        let width = if quoted && bytes[count] == b'\\' {
            let escaped = *bytes
                .get(count + 1)
                .context("history_display_invalid_string")?;
            if escaped == b'u' {
                let hex = std::str::from_utf8(
                    bytes
                        .get(count + 2..count + 6)
                        .context("history_display_invalid_string")?,
                )?;
                let high = u16::from_str_radix(hex, 16)
                    .map_err(|_| anyhow::anyhow!("history_display_invalid_string"))?;
                if (0xd800..=0xdbff).contains(&high) {
                    12
                } else {
                    6
                }
            } else {
                2
            }
        } else {
            match bytes[count] {
                0..=0x7f => 1,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => anyhow::bail!("history_display_invalid_offset"),
            }
        };
        ensure!(
            count + width <= bytes.len(),
            "history_display_invalid_string"
        );
        if count + width > CHUNK {
            break;
        }
        count += width;
    }
    let text = if quoted {
        let mut json = Vec::with_capacity(count + 2);
        json.push(b'"');
        json.extend_from_slice(&bytes[..count]);
        json.push(b'"');
        serde_json::from_slice::<String>(&json)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_string"))?
    } else {
        std::str::from_utf8(&bytes[..count])
            .map_err(|_| anyhow::anyhow!("history_display_invalid_string"))?
            .to_owned()
    };
    ensure!(check(count as u64), "history_display_cancelled");
    let next = start + count as u64;
    ensure!(next == end || count > 0, "history_display_cursor_stalled");
    Ok(HistoricalTextChunk {
        text,
        next_offset: (next < end).then_some(next),
        source_bytes: value.bytes,
        decoded_bytes: value.decoded_bytes,
        encoding: value.encoding,
    })
}
