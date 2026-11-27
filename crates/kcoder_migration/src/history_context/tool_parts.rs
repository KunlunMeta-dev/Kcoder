//! Only typed direct content items may contribute plaintext or attachment references.
use super::*;
use crate::history_json::{self, Segment, Value};
pub(super) enum ToolPart {
    Text {
        source_index: Option<u32>,
        value: HistoricalValueRef,
    },
    Attachment {
        source_index: u32,
        index: u32,
    },
}
pub(super) struct Parts {
    pub items: Vec<ToolPart>,
    pub opaque: u64,
    pub unknown: u64,
}
pub(super) fn collect(
    archive: &ExternalHistoryReader,
    source: MigrationSourceKind,
    parent: &HistoricalValueRef,
    maximum: usize,
    check: &mut impl FnMut(HistoryContextProgress) -> bool,
    position: u64,
) -> Result<Parts> {
    if parent.encoding == HistoricalValueEncoding::JsonString {
        return Ok(Parts {
            items: vec![ToolPart::Text {
                source_index: None,
                value: parent.clone(),
            }],
            opaque: 0,
            unknown: 0,
        });
    }
    let mut result = Parts {
        items: Vec::new(),
        opaque: 0,
        unknown: 0,
    };
    let mut pending: Option<(u64, Option<String>, Option<HistoricalValueRef>)> = None;
    let mut array = false;
    let mut attachment = 0u32;
    history_json::walk(
        archive.open_record_range(parent.record, parent.offset, parent.bytes)?,
        |path, node| {
            if let [Segment::Index(at), Segment::Key(key)] = path
                && (key == "type" || key == "text")
            {
                if pending.as_ref().is_none_or(|p| p.0 != *at) {
                    pending = Some((*at, None, None));
                }
                let entry = pending.as_mut().unwrap();
                if let Value::String(text) = &node.value {
                    if key == "type" && text.bytes == text.preview.len() as u64 {
                        entry.1 = Some(text.preview.clone());
                    }
                    if key == "text" {
                        entry.2 = Some(HistoricalValueRef {
                            record: parent.record,
                            offset: parent.offset + node.span.start,
                            bytes: node.span.end - node.span.start,
                            encoding: HistoricalValueEncoding::JsonString,
                            decoded_bytes: Some(text.bytes),
                            decoded_sha256: Some(text.sha256.clone()),
                            preview: None,
                        });
                    }
                }
            }
            if let [Segment::Index(at)] = path {
                let value = pending.take().filter(|v| v.0 == *at);
                let kind = value.as_ref().and_then(|v| v.1.as_deref());
                let part = if matches!(kind, Some("text" | "input_text" | "output_text")) {
                    match value.and_then(|v| v.2) {
                        Some(value) => Some(ToolPart::Text {
                            source_index: Some(u32::try_from(*at)?),
                            value,
                        }),
                        None => {
                            result.unknown += 1;
                            None
                        }
                    }
                } else if kind
                    .and_then(|v| crate::history_tool_attachments::kind_code(source, v))
                    .is_some()
                {
                    let index = attachment;
                    attachment = attachment
                        .checked_add(1)
                        .context("history_context_part_budget_exceeded")?;
                    Some(ToolPart::Attachment {
                        source_index: u32::try_from(*at)?,
                        index,
                    })
                } else if matches!(
                    kind,
                    Some("encrypted_content" | "thinking" | "redacted_thinking")
                ) {
                    result.opaque += 1;
                    None
                } else {
                    result.unknown += 1;
                    None
                };
                if let Some(part) = part {
                    ensure!(
                        result.items.len() < maximum,
                        "history_context_part_budget_exceeded"
                    );
                    result.items.push(part);
                }
            }
            if path.is_empty() {
                array = matches!(node.value, Value::Array);
            }
            Ok(())
        },
        |bytes| {
            check(HistoryContextProgress {
                phase: HistoryContextPhase::Reading,
                position,
                bytes,
            })
        },
    )?;
    ensure!(array, "history_context_unsupported_tool_envelope");
    Ok(result)
}
