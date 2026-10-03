//! Preserve screenshots in live tool events without allowing an oversized frame.
use kcoder_app_protocol::ToolOutputImage;
use kcoder_types::ContentBlock;
const MAX_IMAGES_BYTES: usize = 1024 * 1024;
pub(super) fn observations(content: &[ContentBlock]) -> (Vec<ToolOutputImage>, bool) {
    let mut images = Vec::new();
    let mut bytes = 0;
    let mut omitted = false;
    for block in content {
        let ContentBlock::Image { source } = block else {
            continue;
        };
        if source.data.is_empty()
            || source.source_type != "base64"
            || !matches!(
                source.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            )
            || source.data.len() > MAX_IMAGES_BYTES.saturating_sub(bytes)
            || !source
                .data
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            omitted = true;
            continue;
        }
        if images.len() >= 16 {
            omitted = true;
            continue;
        }
        bytes += source.data.len();
        images.push(ToolOutputImage {
            mime_type: source.media_type.clone(),
            data: source.data.clone(),
        });
    }
    (images, omitted)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_supported_images_and_bounds_inline_observations() {
        let image = |mime: &str, data: String| ContentBlock::Image {
            source: kcoder_types::ImageSource::base64(mime, data),
        };
        let (images, omitted) = observations(&[
            image("image/png", "YWJj".into()),
            image("image/svg+xml", "YWJj".into()),
            image("image/png", "A".repeat(MAX_IMAGES_BYTES)),
        ]);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, "YWJj");
        assert!(omitted);
        assert_eq!(observations(&[]), (vec![], false));
    }
}

/// Bound images across a coalesced history row, retaining newest observations.
/// Older omitted image payloads remain in raw session history, not inline JSONL.
pub(super) fn bound_history_blocks(blocks: &mut [serde_json::Value]) {
    let mut remaining = MAX_IMAGES_BYTES;
    for block in blocks.iter_mut().rev() {
        let Some(images) = block
            .get_mut("outputImages")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let before = images.len();
        images.retain(|image| {
            let size = image
                .get("data")
                .and_then(serde_json::Value::as_str)
                .map_or(usize::MAX, str::len);
            if size > remaining {
                false
            } else {
                remaining -= size;
                true
            }
        });
        if images.len() != before {
            block["outputImagesOmitted"] = serde_json::json!(true);
        }
    }
}
