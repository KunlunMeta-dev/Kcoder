//! Preserve screenshots in live tool events without allowing an oversized frame.
use kcoder_app_protocol::{ThreadMessage, ToolOutputImage};
use kcoder_types::{
    ContentBlock,
    computer_use::{DESKTOP_SCREENSHOT_BASE64_BYTES, is_desktop_screenshot_tool},
};
use serde_json::{Value, json};
const MAX_IMAGES_BYTES: usize = 1024 * 1024;
pub const TRANSCRIPT_RESPONSE_BYTES: usize = 1_750_000;

pub fn observations(tool_name: &str, content: &[ContentBlock]) -> (Vec<ToolOutputImage>, bool) {
    let budget = if is_desktop_screenshot_tool(tool_name) {
        DESKTOP_SCREENSHOT_BASE64_BYTES
    } else {
        MAX_IMAGES_BYTES
    };
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
            || source.data.len() > budget.saturating_sub(bytes)
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

/// Bound images across a coalesced history row, retaining newest observations.
/// Older omitted image payloads remain in raw session history, not inline JSONL.
pub fn bound_history_blocks(blocks: &mut [Value]) {
    let mut remaining = MAX_IMAGES_BYTES;
    for block in blocks.iter_mut().rev() {
        let desktop = block["tool_name"]
            .as_str()
            .is_some_and(is_desktop_screenshot_tool);
        let Some(images) = block.get_mut("outputImages").and_then(Value::as_array_mut) else {
            continue;
        };
        let before = images.len();
        images.retain(|image| {
            let size = image["data"].as_str().map_or(usize::MAX, str::len);
            // A single large desktop image can use the extended budget if no
            // newer image was kept. Ordinary and mixed rows retain their cap.
            let budget = if desktop && remaining == MAX_IMAGES_BYTES {
                DESKTOP_SCREENSHOT_BASE64_BYTES
            } else {
                remaining
            };
            if size > budget {
                false
            } else {
                remaining = remaining.saturating_sub(size);
                true
            }
        });
        if images.len() != before {
            block["outputImagesOmitted"] = json!(true);
        }
    }
}

/// Keep indexed rows readable even when a screenshot shares the row with large
/// previews or other blocks. The original image remains in raw history.
pub fn bound_desktop_history_row(row: &mut ThreadMessage) {
    let large_screenshot = row.blocks.iter().position(|block| {
        block["tool_name"]
            .as_str()
            .is_some_and(is_desktop_screenshot_tool)
            && block["outputImages"].as_array().is_some_and(|images| {
                images.iter().any(|image| {
                    image["data"]
                        .as_str()
                        .is_some_and(|data| data.len() > MAX_IMAGES_BYTES)
                })
            })
    });
    if let Some(index) = large_screenshot
        && serde_json::to_vec(row).is_ok_and(|bytes| bytes.len() > TRANSCRIPT_RESPONSE_BYTES - 4096)
    {
        // The extended image is the only inline image retained in this row.
        row.blocks[index]["outputImages"] = json!([]);
        row.blocks[index]["outputImagesOmitted"] = json!(true);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_supported_images_and_bounds_inline_observations() {
        let image = |mime: &str, data: String| ContentBlock::Image {
            source: kcoder_types::ImageSource::base64(mime, data),
        };
        let (images, omitted) = observations(
            "read",
            &[
                image("image/png", "YWJj".into()),
                image("image/svg+xml", "YWJj".into()),
                image("image/png", "A".repeat(MAX_IMAGES_BYTES)),
            ],
        );
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, "YWJj");
        assert!(omitted);
        assert_eq!(observations("read", &[]), (vec![], false));
    }
}
