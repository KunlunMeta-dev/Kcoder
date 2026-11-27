use kcoder_app_protocol::*;
use serde_json::json;
#[test]
fn upload_exact_shapes_and_generation_bounds() {
    let base = json!({"ownerRequest":{"clientOwnerRequestId":"o1.root.1.0123456789abcdef0123456789abcdef","immutableParameters":{"purpose":"upload"}},
      "clientUploadId":"u1.root.1.0123456789abcdef0123456789abcdef", "trustedContext":{"gatewayNamespaceId":"gw","deviceId":"device","authorizationGeneration":"auth","targetFingerprint":"target","principal":{"kind":"localOs"}}});
    let read: RetentionUploadParamsV1 = serde_json::from_value(base.clone()).unwrap();
    assert!(read.validate_for(METHOD_RETENTION_UPLOAD_READ).is_ok());
    assert!(read.validate_for(METHOD_RETENTION_UPLOAD_START).is_err());
    let mut start = base.clone();
    start["filename"] = json!("a.txt");
    start["size"] = json!(100 * 1024 * 1024u64);
    start["contentSha256"] = json!("00".repeat(32));
    assert!(
        serde_json::from_value::<RetentionUploadParamsV1>(start.clone())
            .unwrap()
            .validate_for(METHOD_RETENTION_UPLOAD_START)
            .is_ok()
    );
    start["size"] = json!(100 * 1024 * 1024u64 + 1);
    assert!(
        serde_json::from_value::<RetentionUploadParamsV1>(start)
            .unwrap()
            .validate_for(METHOD_RETENTION_UPLOAD_START)
            .is_err()
    );
    let mut forged = base;
    forged["workspaceTargetId"] = json!("public");
    assert!(serde_json::from_value::<RetentionUploadParamsV1>(forged).is_err());
    assert!(
        retention_upload_generation_id("u1.root.01.0123456789abcdef0123456789abcdef", "u1")
            .is_err()
    );
    assert!(
        retention_upload_generation_id(
            "u1.root.18446744073709551616.0123456789abcdef0123456789abcdef",
            "u1"
        )
        .is_err()
    );
}
