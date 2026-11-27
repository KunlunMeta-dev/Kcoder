use super::super::{service::PeerMessageService, ssh_parent::PeerSshLaunch};
use super::*;
use crate::app_server::ct85_test_support;
use kcoder_app_protocol::RetentionParentLaunchV1;
use kcoder_config::{ConfigPaths, PrivateDirectory};
use kcoder_host_transport::{
    ssh_peer_facts::GatewaySshFactChallenge, ssh_peer_pins::SshPeerPinStore,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    ffi::OsStr,
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::PathBuf,
};

struct StdioFixture {
    input: File,
    output: File,
    _peers: [UnixStream; 4],
}
impl StdioFixture {
    fn new() -> Self {
        let input = duplicate(libc::STDIN_FILENO).unwrap();
        let output = duplicate(libc::STDOUT_FILENO).unwrap();
        let (read, write) = UnixStream::pair().unwrap();
        let (out, sink) = UnixStream::pair().unwrap();
        assert!(unsafe { libc::dup2(read.as_raw_fd(), libc::STDIN_FILENO) } >= 0);
        assert!(unsafe { libc::dup2(out.as_raw_fd(), libc::STDOUT_FILENO) } >= 0);
        Self {
            input,
            output,
            _peers: [read, write, out, sink],
        }
    }
}
impl Drop for StdioFixture {
    fn drop(&mut self) {
        unsafe {
            libc::dup2(self.input.as_raw_fd(), libc::STDIN_FILENO);
            libc::dup2(self.output.as_raw_fd(), libc::STDOUT_FILENO);
        }
    }
}
fn name(value: &str) -> PeerSshIdentityTextV1 {
    value.to_owned().try_into().unwrap()
}
fn key() -> Ed25519KeyPair {
    let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap()
}
fn request(method: &str, params: serde_json::Value) -> PeerSshAuthRequestV1 {
    PeerSshAuthRequestV1::decode(
        &serde_json::to_string(
            &serde_json::json!({"jsonrpc":"2.0","id":"auth-owned","method":method,"params":params}),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn enrolled_parent_requires_saved_pins_fresh_gateway_proof_and_live_original_scope() {
    for case in [
        "no-pin",
        "wrong-gateway",
        "complete-revoke",
        "profile-key-drift",
        "stdio-drift",
    ] {
        ct85_test_support::run_owned_case(
            &format!("{}::owned_enrolled_parent_dispatch", module_path!()),
            case,
        );
    }
}

#[test]
#[ignore = "Only the owning parent test may launch this isolated stdio workload"]
fn owned_enrolled_parent_dispatch() {
    let case = ct85_test_support::owned_case();
    let workspace = ct85_test_support::owned_tempdir();
    let config = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").unwrap());
    let directory = PrivateDirectory::open_existing(&config).unwrap();
    directory
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"cross_session_messages":{"enabled":true,"wake_idle":false}}"#,
        )
        .unwrap();
    let paths = ConfigPaths::with_config_dir(workspace.path(), config.clone());
    let authority = Arc::new(
        NativePeerRouterAuthority::capture(
            &RetentionParentLaunchV1::LocalOs,
            &config,
            &config,
            workspace.path(),
            true,
        )
        .unwrap()
        .unwrap(),
    );
    let actual = authority.ssh_profile_observation().unwrap();
    let gateway_key = key();
    let pin = PeerSshEnrollmentV1 {
        version: 1,
        purpose: PeerSshEnrollmentPurposeV1::Enrollment,
        enrollment_id: name("explicit-owned-pin"),
        generation: 1,
        gateway: PeerSshGatewayKeyV1 {
            gateway_id: name("owned-gateway"),
            key_generation: 1,
            public_key: gateway_key.public_key().as_ref().try_into().unwrap(),
        },
        target: PeerSshTargetBindingV1 {
            target_id: name("owned-ssh-target"),
            target_revision: "a".repeat(64).try_into().unwrap(),
            account_generation: name("owned-account-generation"),
            ssh_host_key: name("ssh-ed25519 SHA256:owned-host-key"),
            ssh_user: name("owned-user"),
        },
        native: actual.clone(),
    };
    if case != "no-pin" {
        SshPeerPinStore::apply_explicit(
            &config,
            &actual,
            &PeerSshPinCommandV1 {
                version: 1,
                purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
                operation_id: name("original-explicit-grant"),
                expected_revision: 0,
                action: PeerSshPinActionV1::Authorize {
                    enrollment: Box::new(pin.clone()),
                },
            },
        )
        .unwrap();
    }
    drop(authority);
    // Stdio replacement occurs only inside this dedicated owned child. These
    // real sockets test self-FD lifetime; they are not an SSH acceptance claim.
    let stdio = StdioFixture::new();
    let service = PeerMessageService::capture_native(
        paths,
        workspace.path().into(),
        None,
        Some(&PeerSshLaunch::Enrolled(pin.enrollment_id.as_str().into())),
    )
    .unwrap();
    assert!(!service.has_private_parent());
    let offer = service.authenticate_enrolled_ssh(&request(
        PEER_SSH_AUTH_OFFER,
        serde_json::json!({"enrollmentId":pin.enrollment_id}),
    ));
    if case == "no-pin" {
        assert!(offer.is_err());
        assert!(SshPeerPinStore::open_existing(&config).unwrap().is_none());
        assert!(!service.has_private_parent());
        service.close();
        drop(stdio);
        return;
    }
    let offer: PeerSshChallengeOfferV1 = serde_json::from_value(offer.unwrap()).unwrap();
    let mut gateway =
        GatewaySshFactChallenge::new(Some(&pin), offer.clone(), MAX_CHALLENGE_LIFETIME).unwrap();
    let proof = service
        .authenticate_enrolled_ssh(&request(
            PEER_SSH_AUTH_NATIVE_PROOF,
            serde_json::json!({"claims":gateway.claims().unwrap()}),
        ))
        .unwrap();
    let proof: PeerSshNativeProofV1 = serde_json::from_value(proof).unwrap();
    assert!(!service.has_private_parent());
    let (mut reply, _) = gateway
        .finish(proof, Some(&pin), |bytes| {
            Ok(gateway_key
                .sign(bytes)
                .as_ref()
                .to_vec()
                .try_into()
                .unwrap())
        })
        .unwrap();
    if case == "wrong-gateway" {
        reply.signature = key()
            .sign(&reply.native.gateway_signing_bytes().unwrap())
            .as_ref()
            .to_vec()
            .try_into()
            .unwrap();
    }
    let complete = service.authenticate_enrolled_ssh(&request(
        PEER_SSH_AUTH_COMPLETE,
        serde_json::json!({"proof":reply}),
    ));
    if case == "wrong-gateway" {
        assert!(complete.is_err());
        assert!(!service.has_private_parent());
        service.close();
        drop(stdio);
        return;
    }
    let complete: PeerSshAuthCompleteResultV1 = serde_json::from_value(complete.unwrap()).unwrap();
    assert_eq!(complete.process_instance, offer.process_instance);
    assert_eq!(complete.enrollment_id, pin.enrollment_id);
    assert!(service.has_private_parent());
    match case.as_str() {
        "complete-revoke" => {
            SshPeerPinStore::apply_explicit(
                &config,
                &actual,
                &PeerSshPinCommandV1 {
                    version: 1,
                    purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
                    operation_id: name("explicit-revoke"),
                    expected_revision: 1,
                    action: PeerSshPinActionV1::Revoke {
                        enrollment_id: pin.enrollment_id,
                        expected_generation: 1,
                    },
                },
            )
            .unwrap();
            assert!(!service.has_private_parent());
        }
        "profile-key-drift" => {
            let router = directory
                .open_child(OsStr::new("peer-router-v1"), false)
                .unwrap();
            let mut owner: serde_json::Value = serde_json::from_slice(
                &std::fs::read(config.join("peer-router-v1/router-owner.json")).unwrap(),
            )
            .unwrap();
            owner["identityEpoch"] = serde_json::json!("different-key-epoch");
            router
                .atomic_replace(
                    OsStr::new("router-owner.json"),
                    &serde_json::to_vec(&owner).unwrap(),
                )
                .unwrap();
            assert!(!service.has_private_parent());
        }
        "stdio-drift" => {
            let (other, _peer) = UnixStream::pair().unwrap();
            assert!(unsafe { libc::dup2(other.as_raw_fd(), libc::STDIN_FILENO) } >= 0);
            assert!(!service.has_private_parent());
        }
        _ => panic!("unregistered owned case"),
    }
    service.close();
    assert!(!service.has_private_parent());
    assert!(!config.join("history").exists());
    drop(stdio);
}
