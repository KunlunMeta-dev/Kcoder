use super::*;
use serde_json::{Value, json};

fn name(value: &str) -> PeerSshIdentityTextV1 {
    value.to_owned().try_into().unwrap()
}
fn pins() -> PeerSshEnrollmentV1 {
    PeerSshEnrollmentV1 {
        version: 1,
        purpose: PeerSshEnrollmentPurposeV1::Enrollment,
        enrollment_id: name("explicit-enrollment"),
        generation: 7,
        gateway: PeerSshGatewayKeyV1 {
            gateway_id: name("gateway-A"),
            public_key: [1; 32],
            key_generation: 2,
        },
        target: PeerSshTargetBindingV1 {
            target_id: name("saved-ssh-target"),
            target_revision: "a".repeat(64).try_into().unwrap(),
            account_generation: name("account-generation"),
            ssh_host_key: name("ssh-ed25519 SHA256:expected-key"),
            ssh_user: name("peer-user"),
        },
        native: PeerSshNativeProfileV1 {
            account_uid: 20001,
            profile_identity: name("physical-profile"),
            target_id: name("native-profile-target"),
            workspace_id: name("physical-workspace"),
            identity_epoch: name("profile-epoch"),
            public_key: [2; 32],
        },
    }
}

#[test]
fn enrollment_wire_is_closed_and_never_accepts_other_purpose_or_credential_fields() {
    let value = serde_json::to_value(pins()).unwrap();
    assert_eq!(
        serde_json::from_value::<PeerSshEnrollmentV1>(value.clone()).unwrap(),
        pins()
    );
    for field in [
        "allow",
        "deviceBearer",
        "retentionProof",
        "authorized",
        "privateParent",
    ] {
        let mut changed = value.clone();
        changed[field] = json!(true);
        assert!(
            serde_json::from_value::<PeerSshEnrollmentV1>(changed).is_err(),
            "{field}"
        );
    }
    for purpose in [
        "kcoder.gateway.connection-proof.v1",
        "kcoder.peer-source.presence.v1",
        "kcoder.peer-message.route.v1",
    ] {
        let mut changed = value.clone();
        changed["purpose"] = purpose.into();
        assert!(serde_json::from_value::<PeerSshEnrollmentV1>(changed).is_err());
    }
    let encoded = serde_json::to_string(&value).unwrap();
    let duplicate = encoded.replacen("\"generation\":7", "\"generation\":7,\"generation\":8", 1);
    assert!(serde_json::from_str::<PeerSshEnrollmentV1>(&duplicate).is_err());
    let nested_duplicate = encoded.replacen(
        "\"keyGeneration\":2",
        "\"keyGeneration\":2,\"keyGeneration\":2",
        1,
    );
    assert!(serde_json::from_str::<PeerSshEnrollmentV1>(&nested_duplicate).is_err());
}

#[test]
fn identity_key_signature_nonce_and_generation_bounds_match_the_wire() {
    for bad in ["", "with\nnewline", "with\u{85}control"] {
        assert!(PeerSshIdentityTextV1::try_from(bad.to_owned()).is_err());
    }
    assert!(PeerSshIdentityTextV1::try_from("中".repeat(256)).is_ok());
    assert!(PeerSshIdentityTextV1::try_from("x".repeat(257)).is_err());
    for bad in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
        assert!(PeerSshNonceV1::try_from(bad).is_err());
    }
    for length in [0, 32, 63, 65, 4096] {
        assert!(serde_json::from_value::<PeerSshSignatureV1>(json!(vec![0u8; length])).is_err());
    }
    for generation in [0, PEER_SSH_MAX_GENERATION + 1] {
        let mut value = serde_json::to_value(pins()).unwrap();
        value["generation"] = json!(generation);
        assert!(serde_json::from_value::<PeerSshEnrollmentV1>(value).is_err());
    }
    let mut value = serde_json::to_value(pins()).unwrap();
    value["gateway"]["publicKey"] = json!(vec![0u8; 31]);
    assert!(serde_json::from_value::<PeerSshEnrollmentV1>(value).is_err());
    let mut value = serde_json::to_value(pins()).unwrap();
    value["version"] = json!(2);
    assert!(serde_json::from_value::<PeerSshEnrollmentV1>(value).is_err());
}

#[test]
fn typed_challenge_preserves_all_pins_and_rejects_reflected_nonces() {
    let mut claims = PeerSshChallengeClaimsV1 {
        version: 1,
        purpose: PeerSshChallengePurposeV1::Challenge,
        enrollment: pins(),
        native_nonce: "a".repeat(64).try_into().unwrap(),
        gateway_nonce: "b".repeat(64).try_into().unwrap(),
        process_instance: "c".repeat(64).try_into().unwrap(),
    };
    claims.validate().unwrap();
    let encoded = serde_json::to_value(&claims).unwrap();
    assert_eq!(
        serde_json::from_value::<PeerSshChallengeClaimsV1>(encoded).unwrap(),
        claims
    );
    claims.gateway_nonce = claims.native_nonce.clone();
    assert_eq!(claims.validate(), Err("peer_ssh_invalid_challenge"));
    let mut encoded = serde_json::to_value(&claims).unwrap();
    encoded["enrollment"]["native"]["actor"] = Value::String("gateway".into());
    assert!(serde_json::from_value::<PeerSshChallengeClaimsV1>(encoded).is_err());
}

#[test]
fn pre_initialize_auth_decoder_rejects_notifications_duplicates_and_other_private_protocols() {
    let good = r#"{"jsonrpc":"2.0","id":"auth-1","method":"peerSsh/auth/offerV1","params":{"enrollmentId":"explicit-enrollment"}}"#;
    PeerSshAuthRequestV1::decode(good)
        .unwrap()
        .params::<PeerSshAuthOfferParamsV1>()
        .unwrap();
    for raw in [
        good.replace("\"id\":\"auth-1\",", ""),
        good.replace("\"id\":\"auth-1\",", "\"id\":null,"),
        good.replace("\"id\":\"auth-1\",", "\"id\":\"auth-1\",\"id\":\"auth-2\","),
        good.replace("\"params\":", "\"authorized\":true,\"params\":"),
        good.replace("peerSsh/auth/offerV1", "agentMessage/router/sshParentBind"),
        format!("{good}{}", " ".repeat(PEER_SSH_AUTH_MAX_BYTES)),
    ] {
        assert!(PeerSshAuthRequestV1::decode(&raw).is_err());
    }
    let duplicate = good.replace(
        "\"enrollmentId\":",
        "\"enrollmentId\":\"first\",\"enrollmentId\":",
    );
    assert!(
        PeerSshAuthRequestV1::decode(&duplicate)
            .unwrap()
            .params::<PeerSshAuthOfferParamsV1>()
            .is_err()
    );
}

#[test]
fn admin_command_has_its_own_purpose_and_no_json_confirmation_or_caller_grant() {
    let mut enrollment = pins();
    enrollment.generation = 1;
    let command = PeerSshPinCommandV1 {
        version: 1,
        purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
        operation_id: name("original-operation"),
        expected_revision: 0,
        action: PeerSshPinActionV1::Authorize {
            enrollment: Box::new(enrollment),
        },
    };
    command.validate().unwrap();
    let encoded = serde_json::to_value(&command).unwrap();
    assert_eq!(
        serde_json::from_value::<PeerSshPinCommandV1>(encoded.clone()).unwrap(),
        command
    );
    for field in ["confirm", "authorized", "deviceBearer", "retentionProof"] {
        let mut value = encoded.clone();
        value[field] = json!(true);
        assert!(serde_json::from_value::<PeerSshPinCommandV1>(value).is_err());
    }
    let mut value = encoded;
    value["purpose"] = json!(PEER_SSH_ENROLLMENT_PURPOSE);
    assert!(serde_json::from_value::<PeerSshPinCommandV1>(value).is_err());
}
