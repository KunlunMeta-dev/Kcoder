//! Native startup configuration captured only after the existing verified parent boundary.
//! The wire value is configuration evidence, never renderer/RPC/Scope authorization.
use super::{
    installed_resources::{
        NativeOfficeLaunchAuthority, NativeOfficeRuntimeAuthority, OfficeNodeRuntimeMode,
    },
    native_host::NativeOfficeInstalledPaths,
    native_host::NativeOfficeProviders,
    turn_binding::install_office_for_accepted_turn,
};
use crate::app_server::{
    integrations::core::NativeIntegrationContext,
    native_component_parent::NativeComponentParentAuthority,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_types::TurnAttemptIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Weak},
};
use tokio_util::sync::CancellationToken;

pub(crate) const NATIVE_OFFICE_STARTUP_ENV: &str = "KCODER_NATIVE_OFFICE_BINDING_V1";
mod scope_transfer;
pub(crate) use scope_transfer::NativeOfficeOriginalScopeSource;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupValue {
    schema_version: u32,
    component_root: PathBuf,
    manifest_sha256: String,
    runtime: RuntimeValue,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeValue {
    program: PathBuf,
    sha256: String,
    mode: String,
    node_version: String,
    electron_version: Option<String>,
}
/// Root constructs this only after the actual OS-held component parent capture.
/// No Deserialize or business constructor can create this authority.
pub(crate) struct NativeOfficeStartupBinding {
    value: StartupValue,
    roots: NativeRoots,
    parent_workspace_digest: String,
    original_launch: String,
    parent_owner: Option<Arc<dyn NativeComponentParentAuthority>>,
    scope_source: Option<Weak<dyn NativeOfficeOriginalScopeSource>>,
    scope_launch: Option<kcoder_types::integrations::core::NativeOfficeScopeLaunch>,
    #[cfg(test)]
    owner_program: Option<PathBuf>,
}
impl std::fmt::Debug for NativeOfficeStartupBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeOfficeStartupBinding { verified_native_launch: captured }")
    }
}
struct NativeRoots {
    profile_identity: String,
    workspace_identity: String,
    workspace_digest: String,
}
impl NativeOfficeStartupBinding {
    pub(crate) fn source_revision(&self) -> String {
        format!("office-resource-{}", self.value.manifest_sha256)
    }
    pub(in crate::app_server) fn capture_after_verified_parent(
        parent: Option<&dyn NativeComponentParentAuthority>,
        engine: &QueryEngine,
        raw: Option<&str>,
    ) -> Result<Option<Self>> {
        let (Some(parent), Some(raw)) = (parent, raw) else {
            return Ok(None);
        };
        let (digest, _principal) = parent
            .administrative_workspace_binding()
            .context("OFFICE_NATIVE_PARENT_UNAVAILABLE")?;
        let roots = native_roots(engine)?;
        ensure!(
            roots.workspace_digest == digest,
            "OFFICE_NATIVE_PARENT_UNAVAILABLE"
        );
        let value = parse_startup_value(raw)?;
        Ok(Some(Self {
            value,
            roots,
            parent_workspace_digest: digest.into(),
            original_launch: raw.into(),
            parent_owner: None,
            scope_source: None,
            scope_launch: None,
            #[cfg(test)]
            owner_program: None,
        }))
    }
    pub(crate) fn verify_context(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<()> {
        context.verify()?;
        self.verify_scope_source(engine)?;
        let roots = native_roots(engine)?;
        ensure!(
            roots.profile_identity == self.roots.profile_identity
                && roots.workspace_identity == self.roots.workspace_identity
                && roots.workspace_digest == self.parent_workspace_digest,
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        ensure!(
            context.profile()?.directory_identity()? == roots.profile_identity
                && context.workspace_directory_identity()? == roots.workspace_identity,
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn with_owned_test_program(mut self, program: &std::path::Path) -> Self {
        self.owner_program = Some(program.into());
        self
    }
    pub(crate) async fn resolve(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
        cancel: &CancellationToken,
    ) -> Result<NativeOfficeInstalledPaths> {
        self.verify_context(context, engine)?;
        let authority = NativeOfficeLaunchAuthority::from_native_launch(
            context,
            &self.value.component_root,
            &self.value.manifest_sha256,
            runtime(&self.value.runtime)?,
        )?;
        #[cfg(test)]
        let authority = match &self.owner_program {
            Some(program) => authority.with_owned_test_program(program),
            None => authority,
        };
        let installed = authority.resolve(cancel).await?;
        self.verify_context(context, engine)?;
        Ok(installed)
    }
    /// The root turn loop calls this on a clone only after durable Accepted.
    pub(crate) async fn install_accepted_turn(
        &self,
        context: &NativeIntegrationContext,
        attempt: &TurnAttemptIdentity,
        engine: QueryEngine,
        providers: NativeOfficeProviders,
        cancel: &CancellationToken,
    ) -> Result<QueryEngine> {
        if engine.effective_studio_work_mode() != kcoder_types::StudioWorkMode::Kworker
            || engine.state.session_mode() != kcoder_state::SessionMode::Default
            || !engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
                .integrations
                .office
                .enabled
        {
            return Ok(engine);
        }
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        self.verify_context(context, &engine)?;
        let authority = NativeOfficeLaunchAuthority::from_native_launch(
            context,
            &self.value.component_root,
            &self.value.manifest_sha256,
            runtime(&self.value.runtime)?,
        )?;
        #[cfg(test)]
        let authority = match &self.owner_program {
            Some(program) => authority.with_owned_test_program(program),
            None => authority,
        };
        let installed = authority.prepare_deferred()?;
        self.verify_context(context, &engine)?;
        install_office_for_accepted_turn(
            context,
            attempt,
            engine,
            installed,
            providers,
            format!("office-resource-{}", self.value.manifest_sha256),
        )
    }
}
fn parse_startup_value(raw: &str) -> Result<StartupValue> {
    ensure!(raw.len() <= 65536, "OFFICE_STARTUP_INVALID");
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .context("OFFICE_STARTUP_INVALID")?;
    ensure!(bytes.len() <= 49152, "OFFICE_STARTUP_INVALID");
    let value: StartupValue = serde_json::from_slice(&bytes).context("OFFICE_STARTUP_INVALID")?;
    ensure!(
        value.schema_version == 1 && value.component_root.is_absolute(),
        "OFFICE_STARTUP_INVALID"
    );
    runtime(&value.runtime)?;
    ensure!(valid_sha(&value.manifest_sha256), "OFFICE_STARTUP_INVALID");
    Ok(value)
}
fn runtime(value: &RuntimeValue) -> Result<NativeOfficeRuntimeAuthority> {
    let mode = match value.mode.as_str() {
        "standalone_node" => OfficeNodeRuntimeMode::StandaloneNode,
        "electron_as_node" => OfficeNodeRuntimeMode::ElectronAsNode,
        _ => anyhow::bail!("OFFICE_RUNTIME_MODE_UNAVAILABLE"),
    };
    NativeOfficeRuntimeAuthority::from_native_launcher(
        &value.program,
        &value.sha256,
        mode,
        &value.node_version,
        value.electron_version.as_deref(),
    )
}
fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
#[cfg(target_os = "linux")]
fn native_roots(engine: &QueryEngine) -> Result<NativeRoots> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let profile_path = engine
        .native_settings_source_path()
        .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
    let profile = PrivateDirectory::open_existing(
        profile_path
            .parent()
            .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
    )?;
    profile.verify_private_directory()?;
    let workspace_path = engine
        .state
        .cwd()
        .canonicalize()
        .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
    let workspace = PrivateDirectory::open_existing(&workspace_path)?;
    let native = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&workspace_path)?
        .metadata()?;
    let account_identity = profile.retention_identity()?;
    // This reproduces the existing retention workspace binding using actual
    // handles, not a client target name or requested JSON scope.
    let workspace_digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "kcoder.retention.workspace.v1",
            unsafe { libc::geteuid() },
            &account_identity,
            &workspace_path,
            (native.dev(), native.ino())
        ))?)
    );
    Ok(NativeRoots {
        profile_identity: profile.directory_identity()?,
        workspace_identity: workspace.directory_identity()?,
        workspace_digest,
    })
}
#[cfg(windows)]
fn native_roots(engine: &QueryEngine) -> Result<NativeRoots> {
    let roots = crate::app_server::native_component_parent::windows_roots(engine)?;
    Ok(NativeRoots {
        profile_identity: roots.profile_identity,
        workspace_identity: roots.workspace_identity,
        workspace_digest: roots.workspace_digest,
    })
}
#[cfg(not(any(target_os = "linux", windows)))]
fn native_roots(_: &QueryEngine) -> Result<NativeRoots> {
    anyhow::bail!("OFFICE_NATIVE_PARENT_UNAVAILABLE")
}

#[cfg(test)]
#[path = "startup_binding_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "linux"))]
#[path = "startup_binding/scope_parent_tests.rs"]
mod scope_parent_tests;
