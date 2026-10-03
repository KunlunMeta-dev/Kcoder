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
    // truncate_utf8_bytes 的第三返回值是字符数；本测试钉住字节语义
    //（"日本語".repeat(2) = 6 字符 × 3 字节 = 18 字节）。
    let payload = turn_file_changes_review_payload("日本語".repeat(2), 1024);
    assert_eq!(payload["diffOriginalBytes"], json!(18));
    assert_eq!(payload["diffTruncated"], json!(false));
}
