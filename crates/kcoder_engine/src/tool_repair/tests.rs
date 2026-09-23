use super::*;
use serde_json::json;
use std::fs;

#[test]
fn canonical_json_sorts_object_keys_recursively() {
    let value: Value =
        serde_json::from_str(r#"{"z":{"z":null,"a":true},"a":[{"z":2,"a":"line\n"}]}"#).unwrap();
    assert_eq!(
        canonical_json(&value),
        r#"{"a":[{"a":"line\n","z":2}],"z":{"a":true,"z":null}}"#
    );
}

#[test]
fn canonical_json_preserves_array_order_and_scalar_encoding() {
    let value = json!([3, 1, 2, null, false, 1.5, "line\n\"quoted\""]);
    assert_eq!(
        canonical_json(&value),
        serde_json::to_string(&value).unwrap()
    );
    assert_ne!(
        canonical_json(&json!([3, 1, 2])),
        canonical_json(&json!([1, 2, 3]))
    );
}

#[test]
fn schema_fingerprint_ignores_recursive_object_key_order() {
    let reversed: Value = serde_json::from_str(
        r#"{"type":"object","required":["z","a"],"properties":{"z":{"type":"number","minimum":1},"a":{"type":"string"}}}"#,
    )
    .unwrap();
    let sorted: Value = serde_json::from_str(
        r#"{"properties":{"a":{"type":"string"},"z":{"minimum":1,"type":"number"}},"required":["z","a"],"type":"object"}"#,
    )
    .unwrap();
    assert_eq!(schema_fingerprint(&reversed), schema_fingerprint(&sorted));

    let mut reordered_array = sorted.clone();
    reordered_array["required"] = json!(["a", "z"]);
    assert_ne!(
        schema_fingerprint(&sorted),
        schema_fingerprint(&reordered_array)
    );
}

include!("tests/sanitization.rs");
include!("tests/ranking.rs");
include!("tests/recording.rs");
include!("tests/storage.rs");
