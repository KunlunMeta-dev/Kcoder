use kcoder_api::accumulate_assistant_text;
use kcoder_types::{ContentBlock, ContentDelta, StreamEvent};

#[test]
fn provider_event_accumulation_ignores_non_text_deltas() {
    let events = vec![
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ThinkingDelta {
                thinking: "内部推理".to_string(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 1,
            delta: ContentDelta::TextDelta {
                text: "公开".to_string(),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 1,
            delta: ContentDelta::TextDelta {
                text: "回答".to_string(),
            },
        },
    ];

    assert_eq!(
        accumulate_assistant_text(&events),
        Some(ContentBlock::Text {
            text: "公开回答".to_string()
        })
    );
}
