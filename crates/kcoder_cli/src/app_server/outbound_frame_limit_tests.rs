use super::*;
use serde_json::json;

#[test]
fn small_frames_pass_through_unchanged() {
    let message = json!({"jsonrpc": "2.0", "id": 7, "result": {"ok": true}});
    let bytes = bounded_outbound_frame(message.clone(), 4096).expect("small frame kept");
    assert_eq!(bytes, serde_json::to_vec(&message).unwrap());
}

#[test]
fn oversized_responses_become_an_error_with_the_same_id() {
    let message = json!({"jsonrpc": "2.0", "id": 7, "result": {"blob": "x".repeat(4096)}});
    let bytes = bounded_outbound_frame(message, 1024).expect("response degrades, connection kept");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["id"], json!(7));
    assert_eq!(value["error"]["code"], json!(OUTBOUND_FRAME_LIMIT_CODE));
    assert!(value.get("result").is_none());
}

#[test]
fn oversized_notifications_are_dropped() {
    let message =
        json!({"jsonrpc": "2.0", "method": "turn/item", "params": {"blob": "x".repeat(4096)}});
    assert!(bounded_outbound_frame(message, 1024).is_none());
}

#[test]
fn projected_large_text_keeps_every_character_in_order_without_dropped_frames() {
    let text = "\u{0}中🙂\n".repeat(400_000);
    let mut projection = StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let frames = projection.project(EngineEvent::AssistantTextDelta(text.clone()));
    let mut reconstructed = String::new();
    let mut previous = 0;
    for frame in frames {
        let sequence = frame["params"]["sequence"].as_u64().unwrap();
        assert!(sequence > previous);
        previous = sequence;
        let bytes = bounded_outbound_frame(frame.clone(), OUTBOUND_FRAME_LIMIT_BYTES)
            .expect("every projected frame must fit");
        assert!(bytes.len() <= OUTBOUND_FRAME_LIMIT_BYTES);
        reconstructed.push_str(frame["params"]["delta"]["text"].as_str().unwrap());
    }
    assert_eq!(reconstructed, text);
}

#[test]
fn projected_large_tool_input_keeps_identity_and_explicit_preview() {
    let mut projection = StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let frames = projection.project(EngineEvent::ToolUseStarted {
        id: "call".into(),
        name: "read".into(),
        input: json!({"path":"original.txt","text":"\u{0}".repeat(500_000)}),
    });
    assert_eq!(frames.len(), 1);
    let frame = &frames[0];
    assert_eq!(frame["params"]["item"]["id"], "call");
    assert_eq!(frame["params"]["item"]["name"], "read");
    assert_eq!(frame["params"]["item"]["inputTruncated"], true);
    assert!(bounded_outbound_frame(frame.clone(), OUTBOUND_FRAME_LIMIT_BYTES).is_some());
}

#[test]
fn projected_large_tool_result_keeps_terminal_state_in_frame_budget() {
    let mut projection = StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let frame = projection
        .project(EngineEvent::ToolResult {
            id: "call".into(),
            name: "read".into(),
            output: kcoder_tools::ToolOutput::text("\u{0}".repeat(500_000)),
        })
        .remove(0);
    assert_eq!(frame["params"]["item"]["status"], "completed");
    assert_eq!(frame["params"]["item"]["outputTruncated"], true);
    assert!(bounded_outbound_frame(frame, OUTBOUND_FRAME_LIMIT_BYTES).is_some());
}

#[test]
fn projected_large_thinking_keeps_all_text_without_dropped_frames() {
    let text = "\u{0}中🙂".repeat(400_000);
    let mut projection = StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let mut combined = String::new();
    for frame in projection.project(EngineEvent::AssistantThinkingDelta(text.clone())) {
        assert!(bounded_outbound_frame(frame.clone(), OUTBOUND_FRAME_LIMIT_BYTES).is_some());
        combined.push_str(frame["params"]["event"]["text"].as_str().unwrap());
    }
    assert_eq!(combined, text);
}

#[test]
fn restored_large_tool_preview_fits_and_preserves_terminal_state() {
    let block = transcript_tool_block(
        "call",
        "read",
        json!({"text":"\u{0}".repeat(500_000)}),
        Some("\u{0}".repeat(500_000)),
        false,
        10,
        Some(20),
    );
    assert_eq!(block["status"], "done");
    assert_eq!(block["tool_input_truncated"], true);
    assert_eq!(block["tool_output_truncated"], true);
    assert!(serde_json::to_vec(&block).unwrap().len() < MAX_TRANSCRIPT_RESPONSE_BYTES);
}

#[test]
fn review_payload_marks_truncation_and_keeps_the_prefix() {
    let small = turn_file_changes_review_payload("tiny diff".to_string(), 4096);
    assert_eq!(small["diff"], json!("tiny diff"));
    assert_eq!(small["diffTruncated"], json!(false));

    let large = turn_file_changes_review_payload("x".repeat(8192), 1024);
    assert_eq!(large["diffTruncated"], json!(true));
    assert_eq!(large["diffOriginalBytes"], json!(8192));
    let diff = large["diff"].as_str().unwrap();
    assert!(diff.len() <= 1024);
}

#[test]
fn review_payload_counts_original_bytes_not_chars() {
    // The truncation helper returns character count; the wire field counts bytes.
    // Two repetitions contain six characters and eighteen UTF-8 bytes.
    let payload = turn_file_changes_review_payload("日本語".repeat(2), 1024);
    assert_eq!(payload["diffOriginalBytes"], json!(18));
    assert_eq!(payload["diffTruncated"], json!(false));
}
