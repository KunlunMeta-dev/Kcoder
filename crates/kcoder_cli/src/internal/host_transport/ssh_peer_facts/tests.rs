use super::*;
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::cell::Cell;

fn name(value: &str) -> PeerSshIdentityTextV1 {
    value.to_owned().try_into().unwrap()
}
struct Fixture {
    native: Ed25519KeyPair,
    gateway: Ed25519KeyPair,
    pins: PeerSshEnrollmentV1,
}
fn key() -> Ed25519KeyPair {
    let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap()
}
fn sign(key: &Ed25519KeyPair, bytes: &[u8]) -> Result<PeerSshSignatureV1> {
    Ok(key.sign(bytes).as_ref().to_vec().try_into().unwrap())
}
impl Fixture {
    fn new() -> Self {
        let native = key();
        let gateway = key();
        let pins = PeerSshEnrollmentV1 {
            version: 1,
            purpose: PeerSshEnrollmentPurposeV1::Enrollment,
            enrollment_id: name("explicit-enrollment"),
            generation: 7,
            gateway: PeerSshGatewayKeyV1 {
                gateway_id: name("gateway-A"),
                public_key: gateway.public_key().as_ref().try_into().unwrap(),
                key_generation: 2,
            },
            target: PeerSshTargetBindingV1 {
                target_id: name("ssh-target"),
                target_revision: "a".repeat(64).try_into().unwrap(),
                account_generation: name("account-generation"),
                ssh_host_key: name("ssh-ed25519 SHA256:host-key"),
                ssh_user: name("uid20001"),
            },
            native: PeerSshNativeProfileV1 {
                account_uid: 20001,
                profile_identity: name("profile-inode"),
                target_id: name("native-target"),
                workspace_id: name("workspace-inode"),
                identity_epoch: name("profile-epoch"),
                public_key: native.public_key().as_ref().try_into().unwrap(),
            },
        };
        Self {
            native,
            gateway,
            pins,
        }
    }
    fn pair(&self) -> (NativeSshFactChallenge, GatewaySshFactChallenge) {
        let native = NativeSshFactChallenge::new(Some(&self.pins), MAX_CHALLENGE_LIFETIME).unwrap();
        let gateway = GatewaySshFactChallenge::new(
            Some(&self.pins),
            native.offer().clone(),
            MAX_CHALLENGE_LIFETIME,
        )
        .unwrap();
        (native, gateway)
    }
}

#[test]
fn both_signatures_are_scope_bound_facts_and_each_local_nonce_is_consumed_once() {
    let fixture = Fixture::new();
    let (mut native, mut gateway) = fixture.pair();
    let claims = gateway.claims().unwrap().clone();
    let proof = native
        .respond(claims.clone(), Some(&fixture.pins), |input| {
            sign(&fixture.native, input)
        })
        .unwrap();
    let (reply, observed_native) = gateway
        .finish(proof.clone(), Some(&fixture.pins), |input| {
            sign(&fixture.gateway, input)
        })
        .unwrap();
    assert_eq!(observed_native.peer(), ObservedSshPeer::NativeProfile);
    assert_eq!(observed_native.claims(), &claims);
    let observed_gateway = native.finish(reply.clone(), Some(&fixture.pins)).unwrap();
    assert_eq!(observed_gateway.peer(), ObservedSshPeer::GatewayKey);
    assert_eq!(observed_gateway.claims(), &claims);
    assert_eq!(
        native.finish(reply, Some(&fixture.pins)).unwrap_err(),
        SshPeerFactError::Consumed
    );
    assert_eq!(
        gateway
            .finish(proof, Some(&fixture.pins), |_| panic!(
                "consumed nonce must not sign"
            ))
            .unwrap_err(),
        SshPeerFactError::Consumed
    );
    let (other_native, other_gateway) = fixture.pair();
    assert_ne!(other_native.offer().native_nonce, claims.native_nonce);
    assert_ne!(
        other_native.offer().process_instance,
        claims.process_instance
    );
    assert_ne!(
        other_gateway.claims().unwrap().gateway_nonce,
        claims.gateway_nonce
    );
}

#[test]
fn first_seen_self_reported_keys_do_not_replace_missing_pins() {
    let fixture = Fixture::new();
    let (native, gateway) = fixture.pair();
    assert!(matches!(
        NativeSshFactChallenge::new(None, MAX_CHALLENGE_LIFETIME),
        Err(SshPeerFactError::MissingPin)
    ));
    assert!(matches!(
        GatewaySshFactChallenge::new(None, native.offer().clone(), MAX_CHALLENGE_LIFETIME),
        Err(SshPeerFactError::MissingPin)
    ));
    let mut unpinned =
        NativeSshFactChallenge::new(Some(&fixture.pins), MAX_CHALLENGE_LIFETIME).unwrap();
    assert_eq!(
        unpinned
            .respond(gateway.claims().unwrap().clone(), None, |_| panic!(
                "no pin must not sign"
            ))
            .unwrap_err(),
        SshPeerFactError::MissingPin
    );
}

#[test]
fn every_target_profile_gateway_and_generation_change_is_signed_and_compared() {
    let fixture = Fixture::new();
    type PinMutation = Box<dyn Fn(&mut PeerSshEnrollmentV1)>;
    let mutations: Vec<PinMutation> = vec![
        Box::new(|p| p.enrollment_id = name("other-enrollment")),
        Box::new(|p| p.generation += 1),
        Box::new(|p| p.gateway.gateway_id = name("other-gateway")),
        Box::new(|p| p.gateway.public_key[0] ^= 1),
        Box::new(|p| p.gateway.key_generation += 1),
        Box::new(|p| p.target.target_id = name("other-target")),
        Box::new(|p| p.target.target_revision = "d".repeat(64).try_into().unwrap()),
        Box::new(|p| p.target.account_generation = name("new-account-generation")),
        Box::new(|p| p.target.ssh_host_key = name("other-host-key")),
        Box::new(|p| p.target.ssh_user = name("uid20002")),
        Box::new(|p| p.native.account_uid = 20002),
        Box::new(|p| p.native.profile_identity = name("other-profile")),
        Box::new(|p| p.native.target_id = name("other-native-target")),
        Box::new(|p| p.native.workspace_id = name("other-workspace")),
        Box::new(|p| p.native.identity_epoch = name("new-profile-epoch")),
        Box::new(|p| p.native.public_key[0] ^= 1),
    ];
    for (index, change) in mutations.into_iter().enumerate() {
        let (mut native, gateway) = fixture.pair();
        let mut claims = gateway.claims().unwrap().clone();
        change(&mut claims.enrollment);
        assert_eq!(
            native
                .respond(claims, Some(&fixture.pins), |_| panic!(
                    "changed scope must not sign"
                ))
                .unwrap_err(),
            SshPeerFactError::ScopeChanged,
            "mutation {index}"
        );
        let (mut native, gateway) = fixture.pair();
        let mut current = fixture.pins.clone();
        change(&mut current);
        assert_eq!(
            native
                .respond(
                    gateway.claims().unwrap().clone(),
                    Some(&current),
                    |_| panic!("changed pin must not sign")
                )
                .unwrap_err(),
            SshPeerFactError::PinsChanged,
            "mutation {index}"
        );
    }
}

#[test]
fn revoked_or_rotated_pins_reject_before_both_completion_boundaries() {
    for revoke in [true, false] {
        let fixture = Fixture::new();
        let (mut native, mut gateway) = fixture.pair();
        let proof = native
            .respond(
                gateway.claims().unwrap().clone(),
                Some(&fixture.pins),
                |b| sign(&fixture.native, b),
            )
            .unwrap();
        let mut rotated = fixture.pins.clone();
        rotated.generation += 1;
        let current = if revoke { None } else { Some(&rotated) };
        assert_eq!(
            gateway
                .finish(proof, current, |_| panic!("revoked pin must not sign"))
                .unwrap_err(),
            if revoke {
                SshPeerFactError::MissingPin
            } else {
                SshPeerFactError::PinsChanged
            }
        );
        let (mut native, mut gateway) = fixture.pair();
        let proof = native
            .respond(
                gateway.claims().unwrap().clone(),
                Some(&fixture.pins),
                |b| sign(&fixture.native, b),
            )
            .unwrap();
        let (reply, facts) = gateway
            .finish(proof, Some(&fixture.pins), |b| sign(&fixture.gateway, b))
            .unwrap();
        assert!(facts.compare_expected_pins(current).is_err());
        assert_eq!(
            native.finish(reply.clone(), current).unwrap_err(),
            if revoke {
                SshPeerFactError::MissingPin
            } else {
                SshPeerFactError::PinsChanged
            }
        );
        assert_eq!(
            native.finish(reply, Some(&fixture.pins)).unwrap_err(),
            SshPeerFactError::Consumed
        );
    }
}

#[test]
fn replay_into_another_native_or_gateway_challenge_is_rejected_before_signing() {
    let fixture = Fixture::new();
    let (mut native, mut gateway) = fixture.pair();
    let proof = native
        .respond(
            gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    let mut another_gateway = GatewaySshFactChallenge::new(
        Some(&fixture.pins),
        native.offer().clone(),
        MAX_CHALLENGE_LIFETIME,
    )
    .unwrap();
    assert_eq!(
        another_gateway
            .finish(proof.clone(), Some(&fixture.pins), |_| panic!(
                "replayed native proof must not sign"
            ))
            .unwrap_err(),
        SshPeerFactError::ScopeChanged
    );
    let (reply, _) = gateway
        .finish(proof, Some(&fixture.pins), |b| sign(&fixture.gateway, b))
        .unwrap();
    let (mut another_native, another_gateway) = fixture.pair();
    another_native
        .respond(
            another_gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    assert_eq!(
        another_native
            .finish(reply, Some(&fixture.pins))
            .unwrap_err(),
        SshPeerFactError::ScopeChanged
    );
}

#[test]
fn wrong_native_signature_never_reaches_the_gateway_signer_and_burns_nonce() {
    let fixture = Fixture::new();
    let (mut native, mut gateway) = fixture.pair();
    let mut proof = native
        .respond(
            gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    proof.signature = sign(&key(), b"self-reported-profile").unwrap();
    let calls = Cell::new(0);
    assert_eq!(
        gateway
            .finish(proof.clone(), Some(&fixture.pins), |_| {
                calls.set(calls.get() + 1);
                sign(&fixture.gateway, b"unused")
            })
            .unwrap_err(),
        SshPeerFactError::SignatureInvalid
    );
    assert_eq!(calls.get(), 0);
    assert_eq!(
        gateway
            .finish(proof, Some(&fixture.pins), |_| panic!(
                "bad proof already consumed nonce"
            ))
            .unwrap_err(),
        SshPeerFactError::Consumed
    );
}

#[test]
fn anonymous_connection_source_presence_and_retention_domains_cannot_complete_handshake() {
    for wrong_domain in [
        b"kcoder.gateway.connection-proof.v1\0".as_slice(),
        b"kcoder.peer-source.presence.v1\0",
        b"kcoder.retention.device-revocation-verifier.v1\0",
        PEER_SSH_NATIVE_FACT_DOMAIN,
    ] {
        let fixture = Fixture::new();
        let (mut native, mut gateway) = fixture.pair();
        let proof = native
            .respond(
                gateway.claims().unwrap().clone(),
                Some(&fixture.pins),
                |b| sign(&fixture.native, b),
            )
            .unwrap();
        let (mut reply, _) = gateway
            .finish(proof.clone(), Some(&fixture.pins), |b| {
                sign(&fixture.gateway, b)
            })
            .unwrap();
        reply.signature = sign(&fixture.gateway, &bytes(wrong_domain, &proof).unwrap()).unwrap();
        assert_eq!(
            native.finish(reply, Some(&fixture.pins)).unwrap_err(),
            SshPeerFactError::SignatureInvalid
        );
    }
}

#[test]
fn signer_callbacks_cannot_substitute_a_key_and_challenges_close_without_routing() {
    let fixture = Fixture::new();
    let (mut native, gateway) = fixture.pair();
    assert_eq!(
        native
            .respond(
                gateway.claims().unwrap().clone(),
                Some(&fixture.pins),
                |b| sign(&key(), b)
            )
            .unwrap_err(),
        SshPeerFactError::SignatureInvalid
    );
    let (mut native, mut gateway) = fixture.pair();
    let proof = native
        .respond(
            gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    assert_eq!(
        gateway
            .finish(proof, Some(&fixture.pins), |b| sign(&key(), b))
            .unwrap_err(),
        SshPeerFactError::SignatureInvalid
    );
    let (mut native, mut gateway) = fixture.pair();
    native.close();
    gateway.close();
    assert_eq!(
        native
            .respond(
                PeerSshChallengeClaimsV1 {
                    version: 1,
                    purpose: PeerSshChallengePurposeV1::Challenge,
                    enrollment: fixture.pins.clone(),
                    native_nonce: native.offer().native_nonce.clone(),
                    gateway_nonce: fresh_nonce().unwrap(),
                    process_instance: native.offer().process_instance.clone()
                },
                Some(&fixture.pins),
                |_| panic!("closed state must not sign")
            )
            .unwrap_err(),
        SshPeerFactError::Consumed
    );
    assert_eq!(gateway.claims().unwrap_err(), SshPeerFactError::Consumed);
}

#[test]
fn local_monotonic_expiry_is_bounded_and_cannot_be_supplied_by_a_peer() {
    let fixture = Fixture::new();
    for lifetime in [
        Duration::ZERO,
        MAX_CHALLENGE_LIFETIME + Duration::from_nanos(1),
    ] {
        assert!(matches!(
            NativeSshFactChallenge::new(Some(&fixture.pins), lifetime),
            Err(SshPeerFactError::Invalid)
        ));
    }
    let (mut native, gateway) = fixture.pair();
    native.until = Instant::now();
    assert_eq!(
        native
            .respond(
                gateway.claims().unwrap().clone(),
                Some(&fixture.pins),
                |_| panic!("expired nonce must not sign")
            )
            .unwrap_err(),
        SshPeerFactError::Expired
    );
    let (mut native, mut gateway) = fixture.pair();
    let proof = native
        .respond(
            gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    gateway.until = Instant::now();
    assert_eq!(
        gateway
            .finish(proof, Some(&fixture.pins), |_| panic!(
                "expired nonce must not sign"
            ))
            .unwrap_err(),
        SshPeerFactError::Expired
    );
    let (mut native, mut gateway) = fixture.pair();
    let proof = native
        .respond(
            gateway.claims().unwrap().clone(),
            Some(&fixture.pins),
            |b| sign(&fixture.native, b),
        )
        .unwrap();
    let (reply, _) = gateway
        .finish(proof, Some(&fixture.pins), |b| sign(&fixture.gateway, b))
        .unwrap();
    native.until = Instant::now();
    assert_eq!(
        native.finish(reply, Some(&fixture.pins)).unwrap_err(),
        SshPeerFactError::Expired
    );
}

#[test]
fn node_and_rust_canonical_transcripts_match_with_known_test_only_ed25519_seeds() {
    let native = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
    let gateway = Ed25519KeyPair::from_seed_unchecked(&[8; 32]).unwrap();
    let enrollment = PeerSshEnrollmentV1 {
        version: 1,
        purpose: PeerSshEnrollmentPurposeV1::Enrollment,
        enrollment_id: name("owned-pin"),
        generation: 1,
        gateway: PeerSshGatewayKeyV1 {
            gateway_id: name("owned-gateway"),
            public_key: gateway.public_key().as_ref().try_into().unwrap(),
            key_generation: 1,
        },
        target: PeerSshTargetBindingV1 {
            target_id: name("owned-target"),
            target_revision: "a".repeat(64).try_into().unwrap(),
            account_generation: name("account-1"),
            ssh_host_key: name("ssh-ed25519 SHA256:fixture"),
            ssh_user: name("owned-peer"),
        },
        native: PeerSshNativeProfileV1 {
            account_uid: 1001,
            profile_identity: name("owned-profile"),
            target_id: name("native-target"),
            workspace_id: name("native-workspace"),
            identity_epoch: name("epoch-1"),
            public_key: native.public_key().as_ref().try_into().unwrap(),
        },
    };
    let claims = PeerSshChallengeClaimsV1 {
        version: 1,
        purpose: PeerSshChallengePurposeV1::Challenge,
        enrollment,
        native_nonce: "1".repeat(64).try_into().unwrap(),
        gateway_nonce: "2".repeat(64).try_into().unwrap(),
        process_instance: "3".repeat(64).try_into().unwrap(),
    };
    let native_bytes = claims.native_signing_bytes().unwrap();
    let proof = PeerSshNativeProofV1 {
        claims,
        signature: sign(&native, &native_bytes).unwrap(),
    };
    let gateway_bytes = proof.gateway_signing_bytes().unwrap();
    let hash = |bytes: &[u8]| {
        ring::digest::digest(&ring::digest::SHA256, bytes)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(
        hash(&native_bytes),
        "8eda2b2c92de35e9284b0b75a64b6f3b96099c98d06b4c38b089ebb856b2a4ef"
    );
    assert_eq!(
        hash(&gateway_bytes),
        "d300bb2b623342aeef815d65fc20d5799d79cc0365410ce9c31bfb122485ab6d"
    );
    verify(
        &proof.claims.enrollment.gateway.public_key,
        &gateway_bytes,
        &sign(&gateway, &gateway_bytes).unwrap(),
    )
    .unwrap();
}
