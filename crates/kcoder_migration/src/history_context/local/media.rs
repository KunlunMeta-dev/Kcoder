//! Bounded admission of actual user-supplied bytes, independent of recorded names and MIME.
use super::*;
use std::io::Cursor;
const IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_EDGE: u32 = 8192;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;
enum Media {
    Text,
    Image(image::ImageFormat),
}

fn safe_text(text: &str) -> bool {
    !text
        .chars()
        .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
}
fn utf8(bytes: &[u8], pending: &mut Vec<u8>) -> bool {
    let mut combined = std::mem::take(pending);
    combined.extend_from_slice(bytes);
    match std::str::from_utf8(&combined) {
        Ok(text) => safe_text(text),
        Err(error) if error.error_len().is_none() => {
            let valid = std::str::from_utf8(&combined[..error.valid_up_to()]).is_ok_and(safe_text);
            pending.extend_from_slice(&combined[error.valid_up_to()..]);
            valid && pending.len() <= 3
        }
        Err(_) => false,
    }
}
pub(super) fn verify(
    receipt: &HistoricalAttachmentReceipt,
    position: u64,
    mut source: impl FnMut(u64, usize) -> Result<Vec<u8>>,
    check: &mut impl FnMut(HistoryContextProgress) -> bool,
) -> Result<std::result::Result<&'static str, &'static str>> {
    let mut digest = Sha256::new();
    let mut offset = 0;
    let mut media = None;
    let mut image_bytes = Vec::new();
    let mut pending = Vec::new();
    while offset < receipt.bytes {
        ensure!(
            check(HistoryContextProgress {
                phase: HistoryContextPhase::VerifyingAttachment,
                position,
                bytes: offset
            }),
            "history_context_cancelled"
        );
        let bytes = source(offset, HISTORICAL_ATTACHMENT_CHUNK_BYTES)?;
        ensure!(
            !bytes.is_empty()
                && bytes.len() <= HISTORICAL_ATTACHMENT_CHUNK_BYTES
                && bytes.len() as u64 <= receipt.bytes.saturating_sub(offset),
            "history_context_local_attachment_truncated"
        );
        if media.is_none() {
            media = Some(match image::guess_format(&bytes) {
                Ok(format @ (image::ImageFormat::Png | image::ImageFormat::Jpeg)) => {
                    if receipt.bytes > IMAGE_BYTES {
                        return Ok(Err("history_context_local_image_budget_exceeded"));
                    }
                    Media::Image(format)
                }
                Ok(_) => return Ok(Err("history_context_local_media_unsupported")),
                Err(_) => {
                    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
                        .to_ascii_lowercase();
                    let head = head.trim_start_matches('\u{feff}').trim_start();
                    if ["%pdf-", "<!doctype", "<html", "<svg", "<?xml"]
                        .iter()
                        .any(|prefix| head.starts_with(prefix))
                    {
                        return Ok(Err("history_context_local_media_unsupported"));
                    }
                    Media::Text
                }
            });
        }
        match media.as_ref().unwrap() {
            Media::Text => {
                if !utf8(&bytes, &mut pending) {
                    return Ok(Err("history_context_local_text_invalid"));
                }
            }
            Media::Image(_) => image_bytes.extend_from_slice(&bytes),
        }
        digest.update(&bytes);
        offset += bytes.len() as u64;
    }
    ensure!(
        format!("{:x}", digest.finalize()) == receipt.sha256,
        "history_context_local_attachment_digest_changed"
    );
    ensure!(
        check(HistoryContextProgress {
            phase: HistoryContextPhase::VerifyingAttachment,
            position,
            bytes: offset
        }),
        "history_context_cancelled"
    );
    let mime = match media.unwrap_or(Media::Text) {
        Media::Text => {
            if !pending.is_empty() {
                return Ok(Err("history_context_local_text_invalid"));
            }
            "text/plain"
        }
        Media::Image(format) => {
            let dimensions = image::ImageReader::with_format(Cursor::new(&image_bytes), format)
                .into_dimensions();
            let Ok((width, height)) = dimensions else {
                return Ok(Err("history_context_local_image_invalid"));
            };
            if width == 0
                || height == 0
                || width.max(height) > MAX_EDGE
                || u64::from(width) * u64::from(height) > MAX_PIXELS
            {
                return Ok(Err("history_context_local_image_budget_exceeded"));
            }
            let mut reader = image::ImageReader::with_format(Cursor::new(&image_bytes), format);
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(MAX_EDGE);
            limits.max_image_height = Some(MAX_EDGE);
            limits.max_alloc = Some(64 * 1024 * 1024);
            reader.limits(limits);
            if reader.decode().is_err() {
                return Ok(Err("history_context_local_image_invalid"));
            }
            format.to_mime_type()
        }
    };
    ensure!(
        check(HistoryContextProgress {
            phase: HistoryContextPhase::VerifyingAttachment,
            position,
            bytes: offset
        }),
        "history_context_cancelled"
    );
    Ok(Ok(mime))
}
