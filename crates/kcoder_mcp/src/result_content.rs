//! Preserve bounded multimodal MCP observations. Never silently discard screenshots
//! or pretend that an unsupported content block was observed by the model.
use crate::model::{CallToolResult, McpContent};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_tools::ToolOutput;
use kcoder_types::{ContentBlock, ImageSource};
#[cfg(test)]
use std::io::Cursor;

// Leave room for text, envelopes and projection metadata inside app-server's
// 2 MiB frame. Producers must scale/crop before encoding, preserving coordinates.
const MAX_IMAGE_BASE64_BYTES: usize = 1024 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_CONTENT_BLOCKS: usize = 128;

pub(crate) fn convert_result(result: CallToolResult) -> ToolOutput {
    let mut output = ToolOutput::text("");
    output.content.clear();
    output.is_error = result.is_error;
    let mut image_bytes = 0;
    let mut text_bytes = 0;
    let mut warnings = Vec::new();
    if result.content.len() > MAX_CONTENT_BLOCKS {
        return ToolOutput::error("MCP content exceeds 128 blocks; request a smaller result");
    }
    for (index, block) in result.content.into_iter().enumerate() {
        let converted = match block.kind.as_str() {
            "text" => block
                .text
                .ok_or("text block is missing text")
                .and_then(|text| bounded_text(text, &mut text_bytes))
                .map_err(str::to_owned),
            "image" => image_block(block, &mut image_bytes, &mut warnings),
            _ => Err(
                "unsupported MCP content type; this observation was not passed to the model"
                    .to_owned(),
            ),
        };
        match converted {
            Ok(block) => output.content.push(block),
            Err(reason) => {
                output.is_error = true;
                output
                    .content
                    .push(text_block(format!("MCP content block {index}: {reason}")));
            }
        }
    }
    if let Some(structured) = result.structured_content {
        // Some servers send structuredContent without a text mirror. Keep it as
        // untrusted tool data, never as an instruction or execution metadata.
        let text = structured.to_string();
        if !output.content.iter().any(
            |block| matches!(block, ContentBlock::Text { text: existing } if existing == &text),
        ) {
            match bounded_text(text, &mut text_bytes) {
                Ok(block) => output.content.push(block),
                Err(reason) => {
                    output.is_error = true;
                    output
                        .content
                        .push(text_block(format!("MCP structuredContent: {reason}")));
                }
            }
        }
    }
    output.content.extend(warnings.into_iter().map(text_block));
    output
}

fn text_block(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text { text: text.into() }
}

fn bounded_text(text: String, total: &mut usize) -> Result<ContentBlock, &'static str> {
    // Count JSON escaped bytes, not just source bytes: control characters can
    // expand sixfold in the transport frame.
    let bytes = serde_json::to_string(&text)
        .map_err(|_| "invalid text")?
        .len();
    if bytes > MAX_TEXT_BYTES.saturating_sub(*total) {
        return Err("text budget exceeded; request a smaller result");
    }
    *total += bytes;
    Ok(text_block(text))
}

fn image_block(
    block: McpContent,
    total: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<ContentBlock, String> {
    let mime = block.mime_type.ok_or("image block is missing mimeType")?;
    let expected = match mime.as_str() {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/webp" => image::ImageFormat::WebP,
        "image/gif" => image::ImageFormat::Gif,
        _ => return Err("unsupported image MIME type; request PNG, JPEG, WebP or GIF".into()),
    };
    let data = block.data.ok_or("image block is missing base64 data")?;
    if data.len() > MAX_IMAGE_BASE64_BYTES.saturating_sub(*total) {
        return Err(format!(
            "Image data is too large: {} base64 bytes; remaining tool-result budget: {} bytes (maximum {} bytes). Request a proportionally resized screenshot; do not crop automatically or substitute OCR.",
            data.len(),
            MAX_IMAGE_BASE64_BYTES.saturating_sub(*total),
            MAX_IMAGE_BASE64_BYTES
        ));
    }
    let decoded = STANDARD.decode(&data).map_err(|_| "invalid image base64")?;
    let format = image::guess_format(&decoded).map_err(|_| "unrecognized image data")?;
    if format != expected {
        return Err("image MIME type does not match its bytes".into());
    }
    let info = kcoder_tools::image_input::inspect(&decoded, &mime)?;
    if let Some(warning) = info.small_warning() {
        warnings.push(warning);
    }
    *total += data.len();
    Ok(ContentBlock::Image {
        source: ImageSource::base64(mime, data),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png() -> String {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        STANDARD.encode(bytes.into_inner())
    }
    fn convert(value: serde_json::Value) -> ToolOutput {
        convert_result(serde_json::from_value(value).unwrap())
    }
    #[test]
    fn preserves_order_images_error_flag_and_structured_data() {
        let data = png();
        let output = convert(json!({"isError":true,"content":[
            {"type":"text","text":"before"},
            {"type":"image","mimeType":"image/png","data":data},
            {"type":"text","text":"after"}
        ],"structuredContent":{"screenWidth":1920}}));
        assert!(output.is_error);
        assert_eq!(output.content.len(), 5);
        assert!(matches!(&output.content[4], ContentBlock::Text { text } if text.contains("2x2")));
        assert_eq!(output.content[0], text_block("before"));
        assert_eq!(
            output.content[1],
            ContentBlock::Image {
                source: ImageSource::base64("image/png", data)
            }
        );
        assert_eq!(output.content[2], text_block("after"));
        assert_eq!(output.content[3], text_block("{\"screenWidth\":1920}"));
    }
    #[test]
    fn oversized_dimensions_are_reported_and_small_images_keep_native_bytes() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let output = convert(
            json!({"content":[{"type":"image","mimeType":"image/png","data":STANDARD.encode(bytes.into_inner())}]}),
        );
        assert!(output.is_error);
        assert!(matches!(&output.content[0],ContentBlock::Text{text} if text.contains("8193x1")));
        assert!(
            !output
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::Image { .. }))
        );
        let data = png();
        let output =
            convert(json!({"content":[{"type":"image","mimeType":"image/png","data":data}]}));
        assert!(!output.is_error);
        assert!(
            output
                .content
                .iter()
                .any(|block| matches!(block,ContentBlock::Image{source} if source.data==data))
        );
        assert!(
            output.content.iter().any(
                |block| matches!(block,ContentBlock::Text{text} if text.contains("without OCR"))
            )
        );
    }
    #[test]
    fn invalid_images_are_explicit_errors_without_losing_adjacent_text() {
        for block in [
            json!({"type":"image","mimeType":"image/png","data":"%%%"}),
            json!({"type":"image","mimeType":"image/jpeg","data":png()}),
            json!({"type":"image","mimeType":"image/svg+xml","data":""}),
            json!({"type":"image","data":png()}),
            json!({"type":"audio","data":""}),
        ] {
            let output = convert(json!({"content":[{"type":"text","text":"observation"},block]}));
            assert!(output.is_error);
            assert_eq!(output.content[0], text_block("observation"));
            assert!(matches!(output.content[1], ContentBlock::Text { .. }));
        }
    }
    #[test]
    fn enforces_encoded_budget_and_deduplicates_structured_mirror() {
        let output = convert(
            json!({"content":[{"type":"image","mimeType":"image/png","data":"A".repeat(MAX_IMAGE_BASE64_BYTES+1)}]}),
        );
        assert!(output.is_error);
        let output = convert(
            json!({"content":[{"type":"text","text":"{\"x\":1}"}],"structuredContent":{"x":1}}),
        );
        assert!(!output.is_error);
        assert_eq!(output.content.len(), 1);
        let output = convert(
            json!({"content":[{"type":"text","text":"\u{0001}".repeat(MAX_TEXT_BYTES/2)}]}),
        );
        assert!(output.is_error);
    }
}
