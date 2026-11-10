//! Only known result payload roots are reference-only; unknown envelopes keep their semantics.
use super::Segment;

pub(super) fn is_reference_payload_descendant(path: &[Segment]) -> bool {
    match path {
        [
            Segment::Key(message),
            Segment::Key(content),
            Segment::Index(_),
            Segment::Key(payload),
            rest @ ..,
        ] if message == "message" && content == "content" && payload == "content" => {
            !rest.is_empty()
        }
        [Segment::Key(payload), Segment::Key(output), rest @ ..]
            if payload == "payload" && output == "output" =>
        {
            !rest.is_empty()
        }
        [
            Segment::Key(payload),
            Segment::Key(history),
            Segment::Index(_),
            Segment::Key(output),
            rest @ ..,
        ] if payload == "payload" && history == "replacement_history" && output == "output" => {
            !rest.is_empty()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_json;
    use crate::history_records::{CapturePolicy, Fields};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn payload_descendants_are_validated_without_retained_metadata_growth() {
        let values = (0..10_000)
            .map(|index| json!({"type":"text","text":format!("result {index}")}))
            .collect::<Vec<_>>();
        for (value, reference) in [
            (
                json!({"message":{"content":[{"type":"tool_result","tool_use_id":"call","content":values}]}}),
                vec![
                    Segment::Key("message".into()),
                    Segment::Key("content".into()),
                    Segment::Index(0),
                    Segment::Key("content".into()),
                ],
            ),
            (
                json!({"payload":{"type":"function_call_output","call_id":"call","output":values}}),
                vec![
                    Segment::Key("payload".into()),
                    Segment::Key("output".into()),
                ],
            ),
            (
                json!({"payload":{"replacement_history":[{"type":"function_call_output","call_id":"call","output":values}]}}),
                vec![
                    Segment::Key("payload".into()),
                    Segment::Key("replacement_history".into()),
                    Segment::Index(0),
                    Segment::Key("output".into()),
                ],
            ),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            let mut fields = Fields {
                nodes: BTreeMap::new(),
                record: 0,
                budget: 0,
                policy: CapturePolicy::ReferencePayloads,
            };
            let mut visited = 0;
            history_json::walk(
                &bytes[..],
                |path, node| {
                    visited += 1;
                    fields.capture(path, node)
                },
                |_| true,
            )
            .unwrap();
            assert!(visited > 30_000);
            assert!(fields.nodes.len() < 20);
            assert!(fields.budget < 16 * 1024);
            assert!(fields.nodes.contains_key(&reference));
            assert!(
                !fields
                    .nodes
                    .keys()
                    .any(|path| path.starts_with(&reference) && path.len() > reference.len())
            );
        }
    }

    #[test]
    fn ordinary_message_blocks_and_unknown_paths_are_not_payload_descendants() {
        for path in [
            vec![
                Segment::Key("message".into()),
                Segment::Key("content".into()),
                Segment::Index(0),
                Segment::Key("text".into()),
            ],
            vec![
                Segment::Key("payload".into()),
                Segment::Key("content".into()),
                Segment::Index(0),
                Segment::Key("text".into()),
            ],
            vec![
                Segment::Key("future".into()),
                Segment::Key("output".into()),
                Segment::Index(0),
            ],
            vec![
                Segment::Key("payload".into()),
                Segment::Key("retained_context".into()),
                Segment::Key("output".into()),
                Segment::Index(0),
            ],
        ] {
            assert!(!is_reference_payload_descendant(&path));
        }
    }
}
