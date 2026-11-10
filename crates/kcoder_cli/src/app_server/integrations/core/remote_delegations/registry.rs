//! Native profile-owned first-party ACP peers. No command, profile or environment comes from tool JSON.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory, SourceDocumentSnapshot,
    integrations::remotes::{
        ConfiguredNativeAcpPeer, ConfiguredNativeSshPeer, NativeRemoteReceiverPolicy,
        RemoteIntegrationSettings,
    },
};
use kcoder_native_scope::NativeIntegrationContext;
pub use kcoder_native_scope::service_identity::remote_installation::{file_identity, program_pin};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    path::{Path, PathBuf},
};

pub struct NativeRemoteRegistry {
    context: NativeIntegrationContext,
    settings: RemoteIntegrationSettings,
    revision: String,
    cli_version: &'static str,
    #[cfg(feature = "test-oracle")]
    installed_test_program: Option<PathBuf>,
}
impl NativeRemoteRegistry {
    pub fn observe(
        context: &NativeIntegrationContext,
        workspace: &dyn Fn() -> PathBuf,
        settings_path: &dyn Fn() -> Option<PathBuf>,
        cli_version: &'static str,
    ) -> Result<Option<Self>> {
        context.verify()?;
        ensure!(
            PrivateDirectory::open_existing(&workspace())?.directory_identity()?
                == context.workspace_directory_identity()?,
            "REMOTE_NATIVE_WORKSPACE_MISMATCH"
        );
        let snapshot = match profile_snapshot(context) {
            Ok(snapshot) => snapshot,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound) =>
            {
                context.verify()?;
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let settings = RemoteIntegrationSettings::from_native_profile_snapshot(snapshot.bytes())?;
        if !settings.enabled {
            context.verify()?;
            return Ok(None);
        }
        let path = settings_path().context("REMOTE_PROFILE_SETTINGS_UNAVAILABLE")?;
        ensure!(
            path.file_name() == Some(OsStr::new("settings.json"))
                && PrivateDirectory::open_existing(
                    path.parent()
                        .context("REMOTE_PROFILE_SETTINGS_UNAVAILABLE")?
                )?
                .directory_identity()?
                    == context.profile()?.directory_identity()?,
            "REMOTE_PROFILE_SETTINGS_TARGET_CHANGED"
        );
        let revision = revision(context, &settings)?;
        Ok(Some(Self {
            context: context.recapture_for_owned_service()?,
            settings,
            revision,
            cli_version,
            #[cfg(feature = "test-oracle")]
            installed_test_program: None,
        }))
    }
    #[cfg(feature = "test-oracle")]
    pub fn with_installed_test_program(mut self, program: PathBuf) -> Self {
        self.installed_test_program = Some(program);
        self
    }
    pub fn peers(&self) -> Result<Vec<Value>> {
        self.check_current()?;
        let mut peers:Vec<Value> = self.settings.native_acp_peers.iter().filter(|peer| peer.enabled).map(|peer|json!({
            "id":peer.id,"title":peer.title,"revision":self.revision,"kind":"native_acp","implementation":"kcoder",
            "version":self.cli_version,"identityState":"not_observed","businessState":"unknown",
            "maximumDurationSeconds":peer.maximum_duration_seconds
        })).collect();
        peers.extend(self.settings.native_ssh_peers.iter().filter(|peer| peer.enabled).map(|peer| json!({
            "id":peer.id,"title":peer.title,"revision":self.revision,"kind":"native_ssh_acp","implementation":"kcoder",
            "version":self.cli_version,"target":peer.target,"identityState":"not_observed","businessState":"unknown",
            "maximumDurationSeconds":peer.maximum_duration_seconds
        })));
        Ok(peers)
    }
    /// Selection data only. Actual Source/target/installation owners remain
    /// mandatory at the caller's Native transport constructor.
    pub fn configured_ssh_peer(
        &self,
        id: &str,
        expected_revision: &str,
    ) -> Result<Option<ConfiguredNativeSshPeer>> {
        self.check_current()?;
        ensure!(
            expected_revision == self.revision,
            "REMOTE_RUNNER_CONFIGURATION_CHANGED"
        );
        Ok(self
            .settings
            .native_ssh_peers
            .iter()
            .find(|peer| peer.enabled && peer.id == id)
            .cloned())
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn check_current(&self) -> Result<()> {
        self.context.verify()?;
        let settings = RemoteIntegrationSettings::from_native_profile_snapshot(
            profile_snapshot(&self.context)?.bytes(),
        )?;
        ensure!(
            settings.enabled && revision(&self.context, &settings)? == self.revision,
            "REMOTE_RUNNER_CONFIGURATION_CHANGED"
        );
        Ok(())
    }
    pub fn bind(
        &self,
        id: &str,
        expected_revision: &str,
        workspace: &Path,
    ) -> Result<NativeFirstPartyPeer> {
        self.check_current()?;
        ensure!(
            expected_revision == self.revision,
            "REMOTE_RUNNER_CONFIGURATION_CHANGED"
        );
        let peer = self
            .settings
            .native_acp_peers
            .iter()
            .find(|peer| peer.id == id && peer.enabled)
            .context("REMOTE_RUNNER_NOT_AVAILABLE")?
            .clone();
        let profile = PrivateDirectory::open_existing(&peer.profile_directory)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? != self.context.profile()?.directory_identity()?,
            "REMOTE_INDEPENDENT_RECEIVER_PROFILE_REQUIRED"
        );
        ensure!(
            workspace.is_absolute() && workspace.is_dir(),
            "REMOTE_RECEIVER_WORKSPACE_REQUIRED"
        );
        // Capture real independent native profile/workspace identities for an explicitly authorized invocation.
        let receiver_settings = profile.read_source_document_snapshot(
            OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || self.context.verify().is_ok(),
        )?;
        RemoteIntegrationSettings::validate_native_receiver(receiver_settings.bytes())?;
        let receiver_policy = RemoteIntegrationSettings::admit_native_sender(
            receiver_settings.bytes(),
            &self.context.scope().account_id,
        )?;
        let receiver_settings_sha256 = receiver_settings.sha256.clone();
        let receiver = NativeIntegrationContext::capture(
            &peer.profile_directory,
            workspace,
            "remote-native-receiver",
            &receiver_settings_sha256,
        )?;
        let program = std::env::current_exe()?;
        #[cfg(feature = "test-oracle")]
        let program = self.installed_test_program.clone().unwrap_or(program);
        ensure!(
            program.is_absolute(),
            "REMOTE_NATIVE_INSTALLATION_UNAVAILABLE"
        );
        #[cfg(target_os = "linux")]
        let anchor = File::open("/proc/self/exe")?;
        #[cfg(not(target_os = "linux"))]
        let anchor = File::open(&program)?;
        #[cfg(feature = "test-oracle")]
        let anchor = if self.installed_test_program.is_some() {
            File::open(&program)?
        } else {
            anchor
        };
        let (identity, sha256) = program_pin(&anchor)?;
        ensure!(
            file_identity(&File::open(&program)?)? == identity,
            "REMOTE_NATIVE_INSTALLATION_CHANGED"
        );
        self.check_current()?;
        Ok(NativeFirstPartyPeer {
            peer,
            receiver,
            program,
            anchor,
            program_identity: identity,
            program_sha256: sha256,
            revision: self.revision.clone(),
            cli_version: self.cli_version,
            receiver_settings_sha256,
            workspace: workspace.to_path_buf(),
            receiver_policy,
            sender_account: self.context.scope().account_id.clone(),
        })
    }
}
fn profile_snapshot(context: &NativeIntegrationContext) -> Result<SourceDocumentSnapshot> {
    context.profile()?.read_source_document_snapshot(
        OsStr::new("settings.json"),
        8 * 1024 * 1024,
        || context.verify().is_ok(),
    )
}
fn revision(
    context: &NativeIntegrationContext,
    settings: &RemoteIntegrationSettings,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            "native-remote-profile/v1",
            context.profile()?.directory_identity()?,
            settings
        ]))?)
    ))
}

/// A first-party peer always uses the currently installed native executable and a separate real profile.
/// Arbitrary external programs need an independent verified identity/budget provider; they are not assumed here.
pub struct NativeFirstPartyPeer {
    peer: ConfiguredNativeAcpPeer,
    receiver: NativeIntegrationContext,
    program: PathBuf,
    anchor: File,
    program_identity: String,
    program_sha256: String,
    revision: String,
    cli_version: &'static str,
    receiver_settings_sha256: String,
    workspace: PathBuf,
    receiver_policy: NativeRemoteReceiverPolicy,
    sender_account: String,
}
impl NativeFirstPartyPeer {
    pub fn identity(&self) -> Value {
        json!({"kind":"native_profile","owner":kcoder_types::integrations::core::IntegrationOwner::from(self.receiver.scope()),
        "identityGeneration":self.receiver.scope().identity_generation,"targetRevision":self.receiver.scope().target_revision,"implementation":"kcoder","version":self.cli_version,"programSha256":self.program_sha256})
    }
    #[cfg(feature = "test-oracle")]
    pub fn id(&self) -> &str {
        &self.peer.id
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn maximum_duration(&self) -> u32 {
        self.peer.maximum_duration_seconds
    }
    pub fn receiver(&self) -> &NativeIntegrationContext {
        &self.receiver
    }
    pub fn receiver_context(&self) -> Result<&NativeIntegrationContext> {
        self.check_current(false)?;
        Ok(&self.receiver)
    }
    pub fn receiver_policy(&self) -> &NativeRemoteReceiverPolicy {
        &self.receiver_policy
    }
    pub fn receiver_settings_sha256(&self) -> &str {
        &self.receiver_settings_sha256
    }
    pub fn original_program_identity(&self) -> Result<&str> {
        self.check_current(false)?;
        Ok(&self.program_identity)
    }
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
    pub fn program(&self) -> &Path {
        &self.program
    }
    #[cfg(target_os = "linux")]
    pub fn executable_anchor(&self) -> Result<File> {
        self.check_current(false)?;
        Ok(self.anchor.try_clone()?)
    }
    #[cfg(target_os = "linux")]
    pub fn verify_executable_anchor(&self, actual: &File) -> Result<()> {
        ensure!(
            file_identity(actual)? == self.program_identity,
            "REMOTE_NATIVE_INSTALLATION_CHANGED"
        );
        Ok(())
    }
    pub fn check_current(&self, full_program: bool) -> Result<()> {
        self.receiver.verify()?;
        let settings = self.receiver.profile()?.read_source_document_snapshot(
            OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || self.receiver.verify().is_ok(),
        )?;
        RemoteIntegrationSettings::validate_native_receiver(settings.bytes())?;
        ensure!(
            RemoteIntegrationSettings::admit_native_sender(settings.bytes(), &self.sender_account)?
                == self.receiver_policy,
            "REMOTE_RECEIVER_CONFIGURATION_CHANGED"
        );
        ensure!(
            settings.sha256 == self.receiver_settings_sha256,
            "REMOTE_RECEIVER_CONFIGURATION_CHANGED"
        );
        let current = File::open(&self.program)?;
        ensure!(
            file_identity(&current)? == self.program_identity
                && file_identity(&self.anchor)? == self.program_identity,
            "REMOTE_NATIVE_INSTALLATION_CHANGED"
        );
        if full_program {
            ensure!(
                program_pin(&current)?.1 == self.program_sha256,
                "REMOTE_NATIVE_INSTALLATION_CHANGED"
            );
        }
        Ok(())
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt};
    #[test]
    fn same_size_in_place_installation_mutation_changes_full_hash_even_with_coarse_timestamps() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("owned-native-installation");
        std::fs::write(&path, b"original-native-binary").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let retained = File::open(&path).unwrap();
        let original = program_pin(&retained).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .write_all(b"modified-native-binary")
            .unwrap();
        let current = program_pin(&retained).unwrap();
        // Some filesystems retain the same timestamp for successive writes.
        // Timestamps are only an invalidation hint; dispatch still checks the full hash.
        assert_ne!(original.1, current.1);
        std::fs::hard_link(&path, temp.path().join("unowned-alias")).unwrap();
        assert!(program_pin(&retained).is_err());
    }
}
