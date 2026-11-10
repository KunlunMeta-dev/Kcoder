use super::super::model::*;
use super::*;
use crate::credentials::ApiKeySelector;
use crate::source_transfer::{TransferAuthority, TransferDestination};

fn offer() -> (PrivateCredentialOffer, PrivateKey) {
    let (public_key, key) = PrivateKey::generate().unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let authority = || TransferAuthority {
        instance_id: uuid::Uuid::new_v4().to_string(),
        account_id: "a".repeat(64),
    };
    let mut offer = PrivateCredentialOffer {
        suite: PRIVATE_SUITE.into(),
        public_key,
        context: PrivateCredentialContext {
            version: 1,
            request_id: request.clone(),
            offer_id: uuid::Uuid::new_v4().to_string(),
            source: authority(),
            destination: TransferDestination {
                grant_id: request,
                authority: authority(),
                scope: "b".repeat(64),
            },
            manifest_sha256: "c".repeat(64),
            entry_id: "e0000-0000".into(),
            source_identity: "d".repeat(64),
            source_binding_revision: "e".repeat(64),
            target_profile_identity: "native-owned-profile".into(),
            target_policy: kcoder_config::CredentialStoreMode::File,
            selections: vec![PrivateCredentialSelection::Provider {
                source_name: "fixture".into(),
                selector: ApiKeySelector::ClaudeConfiguration,
                target_name: "Imported".into(),
                endpoint: "https://example.invalid".into(),
                api_format: "anthropic".into(),
            }],
        },
    };
    offer.context.destination.scope = super::super::super::model::digest(&(
        "source-transfer.target/1",
        &offer.context.target_profile_identity,
        &offer.context.destination.authority,
    ))
    .unwrap();
    (offer, key)
}

#[test]
fn standard_hpke_one_shot_roundtrip_restores_the_same_key_without_a_global_provider() {
    let original_provider =
        rustls::crypto::CryptoProvider::get_default().map(std::sync::Arc::as_ptr);
    let (offer, key) = offer();
    let values = Values(vec![Zeroizing::new(
        "SYNTHETIC_HPKE_PRIVATE_VALUE_NEVER_PUBLIC".into(),
    )]);
    let envelope = seal(&offer, &values).unwrap();
    assert!(
        !serde_json::to_string(&envelope)
            .unwrap()
            .contains("SYNTHETIC_HPKE_PRIVATE_VALUE_NEVER_PUBLIC")
    );
    let restored = PrivateKey::restore(key.bytes().to_vec()).unwrap();
    let opened = open(&offer, &envelope, &restored).unwrap();
    assert!(opened.0[0].as_str() == values.0[0].as_str());
    assert!(!format!("{envelope:?}").contains(&envelope.ciphertext));
    assert!(!format!("{offer:?}").contains(&offer.public_key));
    assert_eq!(
        original_provider,
        rustls::crypto::CryptoProvider::get_default().map(std::sync::Arc::as_ptr)
    );
}

#[test]
fn hpke_rejects_a_different_recipient_aad_tampering_or_malformed_ciphertext() {
    let (offer, key) = offer();
    let values = Values(vec![Zeroizing::new("SYNTHETIC_HPKE_PRIVATE_VALUE".into())]);
    let envelope = seal(&offer, &values).unwrap();
    let (_, other_key) = PrivateKey::generate().unwrap();
    assert!(open(&offer, &envelope, &other_key).is_err());
    let mut changed = offer.clone();
    changed.context.selections[0] = PrivateCredentialSelection::Provider {
        source_name: "fixture".into(),
        selector: ApiKeySelector::ClaudeConfiguration,
        target_name: "Another".into(),
        endpoint: "https://example.invalid".into(),
        api_format: "anthropic".into(),
    };
    let mut claimed = envelope.clone();
    claimed.offer_sha256 = digest(&offer_bytes(&changed).unwrap());
    assert!(open(&changed, &claimed, &key).is_err());
    for length in [0, 1, 15, 1000000] {
        let mut bad = envelope.clone();
        bad.ciphertext = "A".repeat(length);
        assert!(open(&offer, &bad, &key).is_err());
    }
    let mut bad = envelope;
    let mut ciphertext = STANDARD.decode(&bad.ciphertext).unwrap();
    ciphertext[0] ^= 1;
    bad.ciphertext = STANDARD.encode(ciphertext);
    assert!(open(&offer, &bad, &key).is_err());
}

#[test]
fn low_order_recipient_and_noncanonical_keys_fail_without_a_plaintext_fallback() {
    let (mut offer, _) = offer();
    let values = Values(vec![Zeroizing::new("SYNTHETIC_PRIVATE".into())]);
    offer.public_key = STANDARD.encode([0; 32]);
    assert!(seal(&offer, &values).is_err());
    offer.public_key = "!".repeat(44);
    assert!(seal(&offer, &values).is_err());
    assert!(PrivateKey::restore(vec![1; 31]).is_err());
}

#[test]
fn private_payload_framing_rejects_extra_slots_truncation_length_overflow_and_trailing_bytes() {
    let values = Values(vec![Zeroizing::new("SYNTHETIC_PRIVATE".into())]);
    let encoded = values.encode().unwrap();
    for length in 0..encoded.len() {
        assert!(Values::decode(&encoded[..length], 1).is_err());
    }
    let mut trailing = encoded.to_vec();
    trailing.push(0);
    assert!(Values::decode(&trailing, 1).is_err());
    let mut wrong = encoded.to_vec();
    wrong[10..12].copy_from_slice(&1u16.to_le_bytes());
    assert!(Values::decode(&wrong, 1).is_err());
    let mut overflow = encoded.to_vec();
    overflow[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(Values::decode(&overflow, 1).is_err());
    assert!(Values::decode(&encoded, 2).is_err());
    assert!(
        Values(vec![Zeroizing::new("x".repeat(MAX_PRIVATE_BYTES))])
            .encode()
            .is_err()
    );
}

// RFC 9180 authors' published mode-0 vector, KEM 0x20/KDF 1/AEAD 2.
// Upstream test-vectors.json SHA256: 61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6.
#[test]
fn explicit_hpke_implementation_opens_the_published_rfc_suite_vector() {
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("testdata/hpke-x25519-aes256.json")).unwrap();
    let bytes = |name: &str| {
        let text = vector[name].as_str().unwrap();
        assert_eq!(text.len() % 2, 0);
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
    };
    let plaintext = DH_KEM_X25519_HKDF_SHA256_AES_256
        .open(
            &EncapsulatedSecret(bytes("enc")),
            &bytes("info"),
            &bytes("aad"),
            &bytes("ciphertext"),
            &HpkePrivateKey::from(bytes("skRm")),
        )
        .unwrap();
    assert_eq!(plaintext, bytes("plaintext"));
}
