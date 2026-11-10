//! Public creation intent never requires a live source registry or a source filesystem read.
use super::super::intent;
use intent::BatchCreateIntent;
use serde_json::json;
const REQUEST: &str = "232abcf1-154c-4366-949e-fb81ed21f5f0";

#[test]
fn canonical_objects_preserve_complete_source_order_initial_values_and_mapping() {
    let a = BatchCreateIntent::new(
        REQUEST,
        &json!({"sources":["expired-source-a","expired-source-b"],"initial":{"bytes":20},"target":{"scope":"project","mapping":{"b":"sub","a":""}}}),
    )
    .unwrap();
    let b = BatchCreateIntent::new(
        REQUEST,
        &json!({"target":{"mapping":{"a":"","b":"sub"},"scope":"project"},"initial":{"bytes":20},"sources":["expired-source-a","expired-source-b"]}),
    )
    .unwrap();
    assert_eq!(a, b);
    assert_eq!(a.request_id(), REQUEST);
    assert_eq!(a.digest().len(), 64);
    for changed in [
        json!({"sources":["expired-source-b","expired-source-a"],"initial":{"bytes":20},"target":{"scope":"project","mapping":{"b":"sub","a":""}}}),
        json!({"sources":["expired-source-a","expired-source-b"],"initial":{"bytes":21},"target":{"scope":"project","mapping":{"b":"sub","a":""}}}),
        json!({"sources":["expired-source-a","expired-source-b"],"initial":{"bytes":20},"target":{"scope":"user","mapping":{"b":"sub","a":""}}}),
        json!({"sources":["expired-source-a","expired-source-b"],"initial":{"bytes":20},"target":{"scope":"project","mapping":{"b":"other","a":""}}}),
    ] {
        assert_ne!(a, BatchCreateIntent::new(REQUEST, &changed).unwrap());
    }
}

#[test]
fn invalid_ids_oversized_and_deep_intents_return_only_static_errors() {
    for id in ["", "not-an-id", "232ABCF1-154C-4366-949E-FB81ED21F5F0"] {
        assert!(BatchCreateIntent::new(id, &json!({})).is_err());
    }
    let private_marker = "DO_NOT_ECHO_UNEXPECTED_RAW_BODY";
    let result = BatchCreateIntent::new(
        REQUEST,
        &json!({"unexpected":private_marker.repeat(40_000)}),
    );
    assert!(!result.unwrap_err().to_string().contains(private_marker));
    let mut deep = json!({});
    for _ in 0..18 {
        deep = json!({"nested":deep});
    }
    assert!(BatchCreateIntent::new(REQUEST, &deep).is_err());
    assert!(BatchCreateIntent::new(REQUEST, &json!({"nodes":vec![0;8192]})).is_err());
    assert!(BatchCreateIntent::new(REQUEST, &json!(["not-an-object"])).is_err());
}
