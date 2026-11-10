use super::*;
use serde_json::{Value, json};
fn locator() -> Value {
    json!({"requestId":"12345678-1234-4123-8123-123456789012", "offerId":"12345678-1234-4123-8123-123456789013",
        "target":{"sessionId":"12345678-1234-4123-8123-123456789014", "purpose":"target_recovery", "targetId":"owned"}})
}
fn run() -> Value {
    json!({"locator":locator(), "source":{"sessionId":"12345678-1234-4123-8123-123456789015","purpose":"source","targetId":"owned-source"},
        "manifestSha256":"a".repeat(64),"entryId":"e0000-0000", "consent":{"apiKeys":true,"mcpPrivateFields":false},
        "selections":[{"kind":"provider","sourceName":"declared","selector":{"kind":"claude_configuration"},
            "targetName":"imported","endpoint":"https://example.invalid","apiFormat":"anthropic"}]})
}
#[test]
fn private_transfer_public_requests_reject_values_keys_authorities_and_unbounded_selections() {
    let original = run();
    assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(original.clone()).is_ok());
    for key in [
        "offer",
        "envelope",
        "publicKey",
        "privateKey",
        "authority",
        "value",
        "sourcePath",
    ] {
        let mut changed = original.clone();
        changed[key] = json!("SYNTHETIC_PRIVATE_DATA");
        assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(changed).is_err());
    }
    let mut changed = original.clone();
    changed["selections"][0]["value"] = json!("SYNTHETIC_PRIVATE_DATA");
    assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(changed).is_err());
    for length in [0, 65] {
        let mut changed = original.clone();
        changed["selections"] = json!(vec![original["selections"][0].clone(); length]);
        assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(changed).is_err());
    }
    let mut changed = original.clone();
    changed["locator"]["offerId"] = json!("../../not-authority");
    assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(changed).is_err());
    let mut changed = original;
    changed["consent"]
        .as_object_mut()
        .unwrap()
        .remove("apiKeys");
    assert!(serde_json::from_value::<MigrationSourceCredentialRunParams>(changed).is_err());
}
#[test]
fn private_transfer_control_never_accepts_ready_as_cancellation_evidence_and_release_requires_explicit_job()
 {
    assert!(
        serde_json::from_value::<MigrationSourceCredentialReleaseParams>(
            json!({"locator":locator(),"jobId":null})
        )
        .is_ok()
    );
    assert!(
        serde_json::from_value::<MigrationSourceCredentialReleaseParams>(
            json!({"locator":locator()})
        )
        .is_err()
    );
    let valid = json!({"locator":locator(),"side":"target","expectedControl":{"sequence":1,"cancelWatermark":0}});
    assert!(serde_json::from_value::<MigrationSourceCredentialResumeParams>(valid.clone()).is_ok());
    let mut changed = valid.clone();
    changed["expectedControl"]["ready"] = json!(true);
    assert!(serde_json::from_value::<MigrationSourceCredentialResumeParams>(changed).is_err());
    let mut changed = valid;
    changed["expectedControl"]["sequence"] = json!(9007199254740992_u64);
    assert!(serde_json::from_value::<MigrationSourceCredentialResumeParams>(changed).is_err());
    let result = json!({"requestId":"owned","offerId":"owned","phase":"offered", "sourceControl":null,
        "targetControl":{"sequence":1,"cancelWatermark":0,"cancelled":false,"ready":false},
        "sourceObserved":false,"targetObserved":true,"sourceWorkerRunning":null,"targetWorkerRunning":false,"received":false,"keyReleased":false});
    assert!(serde_json::from_value::<MigrationSourceCredentialResult>(result.clone()).is_ok());
    let mut changed = result;
    changed
        .as_object_mut()
        .unwrap()
        .remove("sourceWorkerRunning");
    assert!(serde_json::from_value::<MigrationSourceCredentialResult>(changed).is_err());
}
#[test]
fn private_lane_envelopes_accept_only_the_declared_ciphertext_shape_without_plaintext_fields() {
    let original = json!({"offerId":"owned", "envelope":{"version":1,"offerId":"owned","offerSha256":"a".repeat(64),
        "encapsulatedKey":"owned","ciphertext":"ciphertext"},"consent":{"apiKeys":true,"mcpPrivateFields":false}});
    assert!(
        serde_json::from_value::<MigrationSourceCredentialAcceptParamsV1>(original.clone()).is_ok()
    );
    let mut changed = original;
    changed["envelope"]["plaintext"] = json!("SYNTHETIC_PRIVATE_DATA");
    assert!(serde_json::from_value::<MigrationSourceCredentialAcceptParamsV1>(changed).is_err());
}
