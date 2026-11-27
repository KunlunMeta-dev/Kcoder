//! Receiver-owned component roots, never inherited from the Source desktop.
#![cfg(target_os = "linux")]

use super::*;
use crate::app_server::native_component_parent::NativeComponentParentAuthority;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::TurnAttemptStatus;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::PathBuf,
};

/// Defaults retain their own session-startup witness. They cannot be passed to
/// the Accepted parent constructor or install an Office tool.
pub(super) struct ReceiverOfficeDefaultsStartup {
    incoming: super::launch::NativeRemoteSessionStartup,
    roots: ReceiverOfficeRoots,
}
impl ReceiverOfficeDefaultsStartup {
    pub(super) fn capture(
        incoming: super::launch::NativeRemoteSessionStartup,
        receiver: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<Self> {
        incoming.verify()?;
        let process = SameNativeParent::capture_for_defaults(&incoming)?;
        let roots = ReceiverOfficeRoots::capture(receiver, engine, process)?;
        let result = Self { incoming, roots };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.incoming.verify()?;
        self.roots.verify()
    }
}

/// Real independent receiver startup after its original prompt dispatch.
/// This type remains separate from the earlier session-default witness.
pub(super) struct ReceiverOfficeStartup {
    incoming: Arc<super::launch::NativeRemoteIncomingLaunch>,
    roots: ReceiverOfficeRoots,
}
impl std::fmt::Debug for ReceiverOfficeStartup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReceiverOfficeStartup { original_receiver_os_roots: held }")
    }
}
impl ReceiverOfficeStartup {
    pub(super) fn capture(
        incoming: Arc<super::launch::NativeRemoteIncomingLaunch>,
        receiver: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<Self> {
        incoming.check_source()?;
        receiver.validate_scope(&incoming.value().receiver_scope)?;
        let expected = incoming.value().receiver_identity["programSha256"]
            .as_str()
            .context("REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED")?;
        let process = SameNativeParent::capture_for_accepted(
            expected,
            incoming
                .value()
                .receiver_program_identity
                .as_deref()
                .context("REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED")?,
        )?;
        let roots = ReceiverOfficeRoots::capture(receiver, engine, process)?;
        let result = Self { incoming, roots };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.incoming.check_source()?;
        self.roots.verify()
    }
}

pub(super) struct ReceiverOfficeRoots {
    receiver: NativeIntegrationContext,
    process: SameNativeParent,
    profile: PrivateDirectory,
    profile_path: PathBuf,
    profile_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    workspace_digest: String,
}
impl ReceiverOfficeRoots {
    pub(super) fn capture(
        receiver: &NativeIntegrationContext,
        engine: &QueryEngine,
        process: SameNativeParent,
    ) -> Result<Self> {
        let profile_path = receiver.profile_path()?.to_owned();
        ensure!(
            engine.settings_persistence_path() == Some(profile_path.join("settings.json")),
            "REMOTE_OFFICE_PROFILE_CHANGED"
        );
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.verify_private_directory()?;
        let workspace_path = engine.state.cwd().canonicalize()?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        ensure!(
            profile.directory_identity()? == receiver.profile()?.directory_identity()?
                && workspace.directory_identity()? == receiver.workspace_directory_identity()?,
            "REMOTE_OFFICE_COMPONENT_ROOT_CHANGED"
        );
        let native = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&workspace_path)?
            .metadata()?;
        let workspace_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.retention.workspace.v1",
                unsafe { libc::geteuid() },
                profile.retention_identity()?,
                &workspace_path,
                (native.dev(), native.ino()),
            ))?)
        );
        let result = Self {
            receiver: receiver.recapture_for_owned_service()?,
            process,
            profile_identity: profile.directory_identity()?,
            profile,
            profile_path,
            workspace_identity: workspace.directory_identity()?,
            workspace,
            workspace_path,
            workspace_digest,
        };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.process.verify()?;
        self.receiver.verify()?;
        self.profile.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                    == self.profile_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && PrivateDirectory::open_existing(&self.workspace_path)?.directory_identity()?
                    == self.workspace_identity,
            "REMOTE_OFFICE_COMPONENT_ROOT_CHANGED"
        );
        verify_current_receiver_profile(&self.profile, &self.receiver.scope().target_revision)?;
        Ok(())
    }
    pub(super) fn digest(&self) -> &str {
        &self.workspace_digest
    }
    pub(super) fn matches(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<bool> {
        self.verify()?;
        Ok(profile.directory_identity()? == self.profile_identity
            && workspace.directory_identity()? == self.workspace_identity)
    }
}
fn verify_current_receiver_profile(
    profile: &PrivateDirectory,
    expected_sha256: &str,
) -> Result<()> {
    profile.verify_private_directory()?;
    let current = profile
        .read_source_document_snapshot(OsStr::new("settings.json"), 8 * 1024 * 1024, || {
            profile.verify_private_directory().is_ok()
        })
        .context("REMOTE_OFFICE_RECEIVER_POLICY_CHANGED")?;
    ensure!(
        current.sha256 == expected_sha256,
        "REMOTE_OFFICE_RECEIVER_POLICY_CHANGED"
    );
    Ok(())
}
/// Only the actual Accepted receiver may use startup roots to install tools.
/// The earlier startup value can choose defaults but cannot create this binding.
pub(super) struct ReceiverOfficeParent {
    startup: Arc<ReceiverOfficeStartup>,
    engine: QueryEngine,
    state: kcoder_state::AppStateLifecycleIdentity,
    accepted: TurnAttemptRecord,
    attempts: TurnAttemptStore,
}
impl ReceiverOfficeParent {
    pub(super) fn bind_accepted(
        startup: Arc<ReceiverOfficeStartup>,
        engine: &QueryEngine,
        accepted: &TurnAttemptRecord,
    ) -> Result<Self> {
        startup.verify()?;
        ensure!(
            accepted.status == TurnAttemptStatus::Accepted
                && accepted.completion.is_none()
                && engine.state.current_history_attempt_identity().as_ref()
                    == Some(&accepted.identity)
                && engine.session_id() == accepted.identity.thread_id
                && engine.settings_persistence_path()
                    == Some(startup.roots.profile_path.join("settings.json"))
                && engine.state.cwd().canonicalize()? == startup.roots.workspace_path,
            "REMOTE_OFFICE_ORIGINAL_RECEIVER_REQUIRED"
        );
        let attempts = TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&accepted.identity.thread_id),
            &accepted.identity.thread_id,
        )?
        .context("REMOTE_OFFICE_ORIGINAL_RECEIVER_REQUIRED")?;
        let value = Self {
            startup,
            engine: engine.clone(),
            state: engine.state.inspection_lifecycle_identity(),
            accepted: accepted.clone(),
            attempts,
        };
        value.verify()?;
        Ok(value)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.startup.verify()?;
        ensure!(
            self.state.matches(&self.engine.state)
                && self
                    .engine
                    .state
                    .current_history_attempt_identity()
                    .as_ref()
                    == Some(&self.accepted.identity)
                && self.startup.incoming.source_store().read_receiver_task(
                    &self.startup.incoming.value().operation,
                    &self.startup.incoming.value().receiver_identity,
                    &self.attempts,
                )? == self.accepted,
            "REMOTE_OFFICE_ORIGINAL_RECEIVER_CHANGED"
        );
        Ok(())
    }
}
impl NativeComponentParentAuthority for ReceiverOfficeParent {
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        self.verify()?;
        Ok((
            &self.startup.roots.workspace_digest,
            kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        ))
    }
    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        self.verify()?;
        ensure!(
            profile.directory_identity()? == self.startup.roots.profile_identity
                && workspace.directory_identity()? == self.startup.roots.workspace_identity,
            "REMOTE_OFFICE_COMPONENT_ROOT_CHANGED"
        );
        Ok(())
    }
}

/// The OS supplies the parent PID. A held pidfd plus both executable handles
/// anchor liveness and the original installed Native bytes; no PID is a grant.
pub(super) struct SameNativeParent {
    process: OwnedFd,
    parent_pid: libc::pid_t,
    parent_program: File,
    own_program: File,
    own_pin: (String, String),
    uid: libc::uid_t,
}
impl SameNativeParent {
    /// The actual running image supplies this pin; no Source path, PID or JSON
    /// field can select the local parent or authenticate an account here.
    pub(super) fn capture_current_installation() -> Result<Self> {
        let own = File::open("/proc/self/exe")?;
        let pin = super::registry::program_pin(&own)?;
        Self::capture_bound(&pin.1, Some(&pin.0), false)
    }
    #[cfg(test)]
    fn capture(expected_sha256: &str) -> Result<Self> {
        Self::capture_bound(expected_sha256, None, true)
    }
    fn capture_for_defaults(startup: &super::launch::NativeRemoteSessionStartup) -> Result<Self> {
        // The original Source already hashed this exact installation before
        // dispatch. This type may select defaults, never install tools or call a model.
        startup.verify()?;
        Self::capture_bound(
            startup.program_sha256()?,
            Some(startup.program_identity()?),
            false,
        )
    }
    fn capture_for_accepted(expected_sha256: &str, expected_identity: &str) -> Result<Self> {
        Self::capture_bound(expected_sha256, Some(expected_identity), true)
    }
    fn capture_bound(
        expected_sha256: &str,
        expected_identity: Option<&str>,
        verify_full: bool,
    ) -> Result<Self> {
        ensure!(
            expected_sha256.len() == 64
                && expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED"
        );
        let uid = unsafe { libc::geteuid() };
        let parent_pid = unsafe { libc::getppid() };
        ensure!(parent_pid > 1, "REMOTE_OFFICE_PARENT_REQUIRED");
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, parent_pid, 0) };
        ensure!(fd >= 0, "REMOTE_OFFICE_PARENT_HANDLE_REQUIRED");
        // SAFETY: pidfd_open returned a fresh descriptor owned by this value.
        let process = unsafe { OwnedFd::from_raw_fd(i32::try_from(fd)?) };
        let parent_program = File::open(format!("/proc/{parent_pid}/exe"))?;
        let own_program = File::open("/proc/self/exe")?;
        let own_identity = super::registry::file_identity(&own_program)?;
        ensure!(
            expected_identity.is_none_or(|identity| identity == own_identity),
            "REMOTE_OFFICE_PARENT_NATIVE_INSTALLATION_MISMATCH"
        );
        let own_pin = if verify_full {
            super::registry::program_pin(&own_program)?
        } else {
            (own_identity, expected_sha256.into())
        };
        ensure!(
            super::registry::file_identity(&parent_program)? == own_pin.0
                && own_pin.1 == expected_sha256,
            "REMOTE_OFFICE_PARENT_NATIVE_INSTALLATION_MISMATCH"
        );
        let result = Self {
            process,
            parent_pid,
            parent_program,
            own_program,
            own_pin,
            uid,
        };
        result.verify()?;
        Ok(result)
    }
    pub(super) fn verify(&self) -> Result<()> {
        let mut event = libc::pollfd {
            fd: self.process.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: the held original pidfd is live and the wait is nonblocking.
        ensure!(
            unsafe { libc::poll(&mut event, 1, 0) } == 0,
            "REMOTE_OFFICE_PARENT_EXITED"
        );
        ensure!(
            unsafe { libc::getppid() } == self.parent_pid,
            "REMOTE_OFFICE_PARENT_CHANGED"
        );
        let status = std::fs::read_to_string(format!("/proc/{}/status", self.parent_pid))?;
        let parent_uid = status
            .lines()
            .find_map(|line| {
                line.strip_prefix("Uid:")?
                    .split_whitespace()
                    .nth(1)?
                    .parse::<libc::uid_t>()
                    .ok()
            })
            .context("REMOTE_OFFICE_PARENT_PRINCIPAL_REQUIRED")?;
        ensure!(
            unsafe { libc::geteuid() } == self.uid && parent_uid == self.uid,
            "REMOTE_OFFICE_PARENT_PRINCIPAL_CHANGED"
        );
        ensure!(
            super::registry::file_identity(&self.parent_program)? == self.own_pin.0
                && super::registry::file_identity(&self.own_program)? == self.own_pin.0
                && super::registry::file_identity(&File::open(format!(
                    "/proc/{}/exe",
                    self.parent_pid
                ))?)?
                    == self.own_pin.0
                && super::registry::file_identity(&File::open("/proc/self/exe")?)?
                    == self.own_pin.0,
            "REMOTE_OFFICE_NATIVE_INSTALLATION_CHANGED"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_installation_selector_cannot_supply_an_os_parent_or_component_authority() {
        for value in ["", "caller-approved", &"g".repeat(64)] {
            assert!(SameNativeParent::capture(value).is_err());
        }
    }

    #[test]
    fn actual_parent_process_still_cannot_match_a_forged_native_installation() {
        assert!(SameNativeParent::capture(&"0".repeat(64)).is_err());
    }

    #[test]
    fn original_receiver_profile_pin_observes_policy_revocation_before_an_office_effect() {
        let temp = tempfile::tempdir().unwrap();
        let profile = PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("receiver"))
            .unwrap();
        profile
            .atomic_replace(
                OsStr::new("settings.json"),
                br#"{"integrations":{"remotes":{"receiver":{"office":{"enabled":true}}}}}"#,
            )
            .unwrap();
        let snapshot = profile
            .read_source_document_snapshot(OsStr::new("settings.json"), 4096, || true)
            .unwrap();
        verify_current_receiver_profile(&profile, &snapshot.sha256).unwrap();
        profile
            .atomic_replace(
                OsStr::new("settings.json"),
                br#"{"integrations":{"remotes":{"receiver":{"office":{"enabled":false}}}}}"#,
            )
            .unwrap();
        assert!(verify_current_receiver_profile(&profile, &snapshot.sha256).is_err());
    }

    #[test]
    fn receiver_profile_hardlink_cannot_substitute_for_the_original_private_policy() {
        let temp = tempfile::tempdir().unwrap();
        let profile = PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("receiver"))
            .unwrap();
        profile
            .atomic_replace(OsStr::new("settings.json"), b"{}")
            .unwrap();
        let snapshot = profile
            .read_source_document_snapshot(OsStr::new("settings.json"), 4096, || true)
            .unwrap();
        std::fs::hard_link(
            temp.path().join("receiver/settings.json"),
            temp.path().join("owned-extra-link"),
        )
        .unwrap();
        assert!(verify_current_receiver_profile(&profile, &snapshot.sha256).is_err());
    }
}
