use super::*;

#[test]
fn partition_preserves_every_utf8_byte_and_rejects_tiny_sources() {
    let text = "中文约束与确切路径。\n\n".repeat(100);
    let (left, right) = bisect_history(&text).unwrap();
    assert_eq!(format!("{left}{right}"), text);
    assert!(!left.is_empty() && !right.is_empty());
    assert!(bisect_history("short").is_err());
}
