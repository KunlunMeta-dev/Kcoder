use kcoder_app_protocol::{AttachmentRetentionResult, ScopedAttachmentRetentionResultV1};
use serde_json::json;

#[test]
fn scoped_retention_wire_keeps_original_service_result_and_strict_camel_case() {
    let old = AttachmentRetentionResult {
        receipt: None,
        epoch_retired: None,
        consume_results: Vec::new(),
    };
    assert_eq!(
        serde_json::to_value(&old).unwrap(),
        json!({"receipt": null})
    );
    let scoped = ScopedAttachmentRetentionResultV1 {
        scope_id: "a".repeat(64),
        result: old,
    };
    let wire = serde_json::to_value(&scoped).unwrap();
    assert_eq!(
        wire,
        json!({"scopeId": "a".repeat(64), "result": {"receipt": null}})
    );
    assert_eq!(
        serde_json::from_value::<ScopedAttachmentRetentionResultV1>(wire).unwrap(),
        scoped
    );
    assert!(
        serde_json::from_value::<ScopedAttachmentRetentionResultV1>(json!({"receipt": null}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<ScopedAttachmentRetentionResultV1>(
            json!({"scope_id": "a".repeat(64), "result": {"receipt": null}})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<ScopedAttachmentRetentionResultV1>(
            json!({"scopeId": "a".repeat(64), "result": {"receipt": null}, "trustedContext": {}})
        )
        .is_err()
    );
}

#[test]
fn scoped_retention_result_does_not_make_missing_receipt_authoritative_absence() {
    assert!(
        serde_json::from_value::<ScopedAttachmentRetentionResultV1>(
            json!({"scopeId": "a".repeat(64), "result": {}})
        )
        .is_err()
    );
    let value = serde_json::from_value::<ScopedAttachmentRetentionResultV1>(json!({
        "scopeId": "a".repeat(64),
        "result": {"receipt": null, "epochRetired": {"rootNamespace": "review", "epoch": 7, "retiredThrough": 6}}
    })).unwrap();
    assert!(value.result.validate("review").is_err());
}
