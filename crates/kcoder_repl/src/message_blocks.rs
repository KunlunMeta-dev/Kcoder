use kcoder_types::{ContentBlock, Message};
use std::collections::HashMap;

pub(crate) fn content_blocks_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    let mut previous_boundary = false;
    let mut image_index = 1usize;
    for block in blocks {
        let current_boundary = content_block_needs_text_boundary(block);
        let skip_current_block_output =
            matches!(block, ContentBlock::Image { .. }) && text_contains_image_placeholder(&out);
        if !skip_current_block_output
            && !out.is_empty()
            && (previous_boundary || current_boundary)
            && !out.ends_with('\n')
        {
            out.push('\n');
        }
        match block {
            ContentBlock::Text { text } => out.push_str(text),
            ContentBlock::ToolUse { id, name, input } => {
                out.push_str(&format!("[tool: {name} {id} {input}]"));
            }
            ContentBlock::ToolResult { content, .. } => out.push_str(&content_blocks_text(content)),
            ContentBlock::Image { .. } => {
                let label = image_placeholder(image_index);
                image_index = image_index.saturating_add(1);
                if !skip_current_block_output {
                    out.push_str(&label);
                }
            }
            ContentBlock::Thinking { thinking, .. } => out.push_str(thinking),
            ContentBlock::RedactedThinking { .. } => out.push_str("[redacted thinking]"),
        }
        if !skip_current_block_output {
            previous_boundary = current_boundary;
        }
    }
    out
}

fn content_block_needs_text_boundary(block: &ContentBlock) -> bool {
    !matches!(
        block,
        ContentBlock::Text { .. } | ContentBlock::Thinking { .. }
    )
}

fn image_placeholder(index: usize) -> String {
    format!("[Image #{index}]")
}

fn text_contains_image_placeholder(text: &str) -> bool {
    text.contains("[Image #")
}

pub(crate) fn collect_tool_use_lookup(messages: &[Message]) -> HashMap<String, (String, String)> {
    let mut lookup = HashMap::new();
    for msg in messages {
        let blocks = match msg {
            Message::User { content, .. } => content,
            Message::Assistant { content, .. } => content,
        };
        for block in blocks {
            if let ContentBlock::ToolUse { id, name, input } = block {
                lookup.insert(id.clone(), (name.clone(), input.to_string()));
            }
        }
    }
    lookup
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::ImageSource;

    #[test]
    fn content_blocks_text_keeps_adjacent_text_blocks_contiguous() {
        let blocks = vec![
            ContentBlock::Text {
                text: "hello ".to_string(),
            },
            ContentBlock::Text {
                text: "world".to_string(),
            },
        ];

        assert_eq!(content_blocks_text(&blocks), "hello world");
    }

    #[test]
    fn content_blocks_text_separates_structured_blocks_from_text() {
        let blocks = vec![
            ContentBlock::Text {
                text: "Read image screen.png.".to_string(),
            },
            ContentBlock::Image {
                source: ImageSource::base64("image/png", "abc123"),
            },
            ContentBlock::Text {
                text: "done".to_string(),
            },
        ];

        assert_eq!(
            content_blocks_text(&blocks),
            "Read image screen.png.\n[Image #1]\ndone"
        );
    }

    #[test]
    fn content_blocks_text_does_not_duplicate_existing_image_placeholders() {
        let blocks = vec![
            ContentBlock::Text {
                text: "[Image #2] describe".to_string(),
            },
            ContentBlock::Image {
                source: ImageSource::base64("image/png", "abc123"),
            },
        ];

        assert_eq!(content_blocks_text(&blocks), "[Image #2] describe");
    }
}
