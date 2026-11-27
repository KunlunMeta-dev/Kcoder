//! Real saved pin, profile key and process-local sockets in the owned child.
//! These cases exercise cold integration; the separate dual-UID suite proves SSH.
use super::*;
use crate::app_server::session_messages::ssh_parent::PeerSshLaunch;
use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
use kcoder_host_transport::{
    ssh_peer_facts::{GatewaySshFactChallenge, MAX_CHALLENGE_LIFETIME},
    ssh_peer_pins::SshPeerPinStore,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::net::UnixStream,
    },
};

struct Stdio {
    original_input: File,
    original_output: File,
    _sockets: [UnixStream; 4],
}
fn duplicate(fd: i32) -> File {
    let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    assert!(fd >= 0);
    unsafe { File::from_raw_fd(fd) }
}
impl Stdio {
    fn new() -> Self {
        let original_input = duplicate(0);
        let original_output = duplicate(1);
        let (input, writer) = UnixStream::pair().unwrap();
        let (output, reader) = UnixStream::pair().unwrap();
        assert!(unsafe { libc::dup2(input.as_raw_fd(), 0) } >= 0);
        assert!(unsafe { libc::dup2(output.as_raw_fd(), 1) } >= 0);
        Self {
            original_input,
            original_output,
            _sockets: [input, writer, output, reader],
        }
    }
}
impl Drop for Stdio {
    fn drop(&mut self) {
        unsafe {
            libc::dup2(self.original_input.as_raw_fd(), 0);
            libc::dup2(self.original_output.as_raw_fd(), 1);
        }
    }
}
pub(super) struct Enrolled {
    _stdio: Stdio,
    original_source_service: Arc<PeerMessageService>,
    actual: PeerSshNativeProfileV1,
    id: PeerSshIdentityTextV1,
    profile: PathBuf,
}
fn name(value: &str) -> PeerSshIdentityTextV1 {
    value.to_owned().try_into().unwrap()
}
fn request(method: &str, params: Value) -> PeerSshAuthRequestV1 {
    PeerSshAuthRequestV1::decode(
        &serde_json::to_string(
            &json!({"jsonrpc":"2.0","id":"owned-cold-auth","method":method,"params":params}),
        )
        .unwrap(),
    )
    .unwrap()
}
impl Enrolled {
    pub(super) fn bind_original_source(&self, cold: &ColdTargetDriver) -> Result<()> {
        ensure!(
            self.original_source_service.identity()? == cold.owner.service.identity()?,
            "the actual dispatcher and Source must share the original profile/workspace"
        );
        // Match the real OwnedTUI composition: publish only this existing
        // dispatcher's cancellation token, never a synthetic allow verdict.
        self.original_source_service
            .bind_cold_target_owner(cold.owner.cancel.clone())
    }
    pub(super) fn revoke(&self, fixture: &Fixture) -> Result<()> {
        SshPeerPinStore::apply_explicit(
            &self.profile,
            &self.actual,
            &PeerSshPinCommandV1 {
                version: 1,
                purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
                operation_id: name("owned-cold-revoke"),
                expected_revision: 1,
                action: PeerSshPinActionV1::Revoke {
                    enrollment_id: self.id.clone(),
                    expected_generation: 1,
                },
            },
        )?;
        assert!(!fixture.service.has_private_parent());
        Ok(())
    }
}
pub(super) fn prepare(fixture: &mut Fixture, case: &str) -> Result<Enrolled> {
    let original_source_service = fixture.service.clone();
    let authority = fixture.service.authority()?;
    let actual = authority.ssh_profile_observation()?;
    let profile = fixture.service.profile_path().to_owned();
    let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
    let pin = PeerSshEnrollmentV1 {
        version: 1,
        purpose: PeerSshEnrollmentPurposeV1::Enrollment,
        enrollment_id: name("owned-cold-v2"),
        generation: 1,
        gateway: PeerSshGatewayKeyV1 {
            gateway_id: name("owned-cold-gateway"),
            public_key: key.public_key().as_ref().try_into().unwrap(),
            key_generation: 1,
        },
        target: PeerSshTargetBindingV1 {
            target_id: name("owned-cold-ssh-target"),
            target_revision: "a".repeat(64).try_into().unwrap(),
            account_generation: name("owned-account-generation"),
            ssh_host_key: name("ssh-ed25519 SHA256:owned-cold"),
            ssh_user: name("owned-cold-user"),
        },
        native: actual.clone(),
    };
    if case != "v2-missing" {
        SshPeerPinStore::apply_explicit(
            &profile,
            &actual,
            &PeerSshPinCommandV1 {
                version: 1,
                purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
                operation_id: name("owned-cold-explicit-pin"),
                expected_revision: 0,
                action: PeerSshPinActionV1::Authorize {
                    enrollment: Box::new(pin.clone()),
                },
            },
        )?;
    }
    let stdio = Stdio::new();
    let paths = ConfigPaths::with_config_dir(&fixture.source.state.cwd(), profile.clone());
    fixture.service = PeerMessageService::capture_native(
        paths,
        fixture.source.state.cwd(),
        None,
        Some(&PeerSshLaunch::Enrolled(pin.enrollment_id.as_str().into())),
    )?;
    assert!(!fixture.service.has_private_parent());
    assert!(fixture.service.check_selected_cold_transport().is_err());
    if matches!(case, "v2-complete" | "v2-revoked") {
        let offer: PeerSshChallengeOfferV1 =
            serde_json::from_value(fixture.service.authenticate_enrolled_ssh(&request(
                PEER_SSH_AUTH_OFFER,
                json!({"enrollmentId":pin.enrollment_id}),
            ))?)?;
        let mut gateway = GatewaySshFactChallenge::new(Some(&pin), offer, MAX_CHALLENGE_LIFETIME)?;
        let proof: PeerSshNativeProofV1 =
            serde_json::from_value(fixture.service.authenticate_enrolled_ssh(&request(
                PEER_SSH_AUTH_NATIVE_PROOF,
                json!({"claims":gateway.claims()?}),
            ))?)?;
        let (reply, _) = gateway.finish(proof, Some(&pin), |bytes| {
            Ok(key.sign(bytes).as_ref().to_vec().try_into().unwrap())
        })?;
        fixture
            .service
            .authenticate_enrolled_ssh(&request(PEER_SSH_AUTH_COMPLETE, json!({"proof":reply})))?;
        assert!(fixture.service.has_private_parent());
    }
    Ok(Enrolled {
        _stdio: stdio,
        original_source_service,
        actual,
        id: pin.enrollment_id,
        profile,
    })
}
