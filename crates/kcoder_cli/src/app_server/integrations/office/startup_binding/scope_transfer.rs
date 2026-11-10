//! The original owned producer and a real scope receiver are separate capabilities.
use super::*;
use kcoder_types::integrations::core::NativeOfficeScopeLaunch;
use std::path::Path;

/// Implement only for the actual original kernel owner and its immutable launch.
/// The serialized record is data; it cannot implement this receiver capability.
pub(crate) trait NativeOfficeOriginalScopeSource: Send + Sync {
    fn verify_original_office_owner(&self, engine: &QueryEngine) -> Result<()>;
    fn original_office_launch(&self) -> Result<Option<NativeOfficeScopeLaunch>>;
}

impl NativeOfficeStartupBinding {
    /// A locator observation only. The original scope source must independently
    /// verify its owned directory handle before this path can be consumed.
    pub(crate) fn scope_component_root(record: &NativeOfficeScopeLaunch) -> Result<PathBuf> {
        record.validate()?;
        Ok(parse_startup_value(&record.original_launch)?.component_root)
    }

    pub(in crate::app_server) fn capture_with_verified_parent_owner(
        parent: Option<Arc<dyn NativeComponentParentAuthority>>,
        engine: &QueryEngine,
        raw: Option<&str>,
    ) -> Result<Option<Self>> {
        let mut captured = Self::capture_after_verified_parent(parent.as_deref(), engine, raw)?;
        if let Some(binding) = captured.as_mut() {
            binding.parent_owner = parent;
        }
        Ok(captured)
    }

    pub(in crate::app_server) fn capture_from_original_scope(
        source: Arc<dyn NativeOfficeOriginalScopeSource>,
        engine: &QueryEngine,
    ) -> Result<Option<Self>> {
        source.verify_original_office_owner(engine)?;
        let Some(record) = source.original_office_launch()? else {
            return Ok(None);
        };
        record.validate()?;
        let roots = native_roots(engine)?;
        ensure!(
            record.profile_identity == roots.profile_identity
                && record.workspace_identity == roots.workspace_identity
                && record.workspace_digest == roots.workspace_digest,
            "OFFICE_SCOPE_ORIGINAL_ROOTS_CHANGED"
        );
        let value = parse_startup_value(&record.original_launch)?;
        ensure!(
            configuration_sha(&value, &roots)? == record.configuration_sha256,
            "OFFICE_SCOPE_ORIGINAL_CONFIGURATION_CHANGED"
        );
        source.verify_original_office_owner(engine)?;
        ensure!(
            source.original_office_launch()?.as_ref() == Some(&record),
            "OFFICE_SCOPE_ORIGINAL_LAUNCH_CHANGED"
        );
        Ok(Some(Self {
            value,
            parent_workspace_digest: roots.workspace_digest.clone(),
            roots,
            original_launch: record.original_launch.clone(),
            parent_owner: None,
            scope_source: Some(Arc::downgrade(&source)),
            scope_launch: Some(record),
            #[cfg(test)]
            owner_program: None,
        }))
    }

    pub(super) fn verify_scope_source(&self, engine: &QueryEngine) -> Result<()> {
        if let Some(source) = &self.scope_source {
            let source = source
                .upgrade()
                .context("OFFICE_SCOPE_ORIGINAL_OWNER_ENDED")?;
            source.verify_original_office_owner(engine)?;
            ensure!(
                source.original_office_launch()?.as_ref() == self.scope_launch.as_ref(),
                "OFFICE_SCOPE_ORIGINAL_LAUNCH_CHANGED"
            );
        }
        Ok(())
    }

    fn verify_owned_parent(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<()> {
        self.verify_context(native, engine)?;
        let parent = self
            .parent_owner
            .as_ref()
            .context("OFFICE_ORIGINAL_PRODUCER_REQUIRED")?;
        let workspace = PrivateDirectory::open_existing(&engine.state.cwd().canonicalize()?)?;
        parent.verify_native_component_roots(native.profile()?, &workspace)?;
        let (digest, _) = parent.administrative_workspace_binding()?;
        ensure!(
            digest == self.parent_workspace_digest,
            "OFFICE_ORIGINAL_PRODUCER_ROOTS_CHANGED"
        );
        self.verify_context(native, engine)
    }

    /// This is configuration data only; retention below verifies every source byte
    /// before the original scope owner can publish a retained launch.
    pub(crate) fn describe_original_scope_launch(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<NativeOfficeScopeLaunch> {
        self.verify_owned_parent(native, engine)?;
        let record = NativeOfficeScopeLaunch {
            schema_version: 1,
            original_launch: self.original_launch.clone(),
            profile_identity: self.roots.profile_identity.clone(),
            workspace_identity: self.roots.workspace_identity.clone(),
            workspace_digest: self.roots.workspace_digest.clone(),
            configuration_sha256: configuration_sha(&self.value, &self.roots)?,
        };
        record.validate()?;
        Ok(record)
    }

    pub(crate) async fn retain_original_scope_launch(
        &self,
        target: &PrivateDirectory,
        path: &Path,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        cancel: &CancellationToken,
    ) -> Result<NativeOfficeScopeLaunch> {
        let mut record = self.describe_original_scope_launch(native, engine)?;
        let copied: super::super::installed_resources::NativeOfficeRetainedScopeResources = self
            .resource_authority(native)?
            .retain_scope_resources(target, path, cancel)
            .await?;
        self.verify_owned_parent(native, engine)?;
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let mut retained = self.value.clone();
        retained.component_root = copied.component_root;
        retained.runtime.program = copied.runtime_program;
        record.original_launch = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&retained)?);
        ensure!(
            configuration_sha(&retained, &self.roots)? == record.configuration_sha256,
            "OFFICE_SCOPE_ORIGINAL_CONFIGURATION_CHANGED"
        );
        record.validate()?;
        Ok(record)
    }

    fn resource_authority(
        &self,
        native: &NativeIntegrationContext,
    ) -> Result<NativeOfficeLaunchAuthority> {
        let authority = NativeOfficeLaunchAuthority::from_native_launch(
            native,
            &self.value.component_root,
            &self.value.manifest_sha256,
            runtime(&self.value.runtime)?,
        )?;
        #[cfg(test)]
        let authority = match &self.owner_program {
            Some(program) => authority.with_owned_test_program(program),
            None => authority,
        };
        Ok(authority)
    }
}

fn configuration_sha(value: &StartupValue, roots: &NativeRoots) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "native-original-office-scope-v1",
            value.schema_version,
            &value.manifest_sha256,
            &value.runtime.sha256,
            &value.runtime.mode,
            &value.runtime.node_version,
            &value.runtime.electron_version,
            &roots.profile_identity,
            &roots.workspace_identity,
            &roots.workspace_digest,
        ))?)
    ))
}
