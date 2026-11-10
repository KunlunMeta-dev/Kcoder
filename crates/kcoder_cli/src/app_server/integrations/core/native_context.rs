//! Bind integration identity to native profile/workspace handles, never RPC labels.
use super::{NativeIdentity, native_identity::NativeIdentitySnapshot};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner, IntegrationScope};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[path = "native_context/organization.rs"]
mod organization;
use organization::OrganizationAuthority;
#[path = "native_context/lifecycle_revision.rs"]
mod lifecycle_revision;
#[path = "native_context/observed_read.rs"]
mod observed_read;
pub use observed_read::ObservedReadScope;

/// An in-process capability captured by the account-owned app-server.
/// Gateway aliases and caller-supplied scope values cannot construct its identity.
pub struct NativeIntegrationContext {
    profile: PrivateDirectory,
    profile_path: PathBuf,
    profile_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    identity: NativeIdentity,
    scope: IntegrationScope,
    lifecycle_revision_name: String,
    lifecycle_revision_required: bool,
    organization: Option<Arc<OrganizationAuthority>>,
    #[cfg(any(test, feature = "native-identity-test-hooks"))]
    identity_checks: std::sync::atomic::AtomicUsize,
}

impl std::fmt::Debug for NativeIntegrationContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeIntegrationContext { native_handles: captured }")
    }
}

impl NativeIntegrationContext {
    pub fn wiki_worker_request(request: serde_json::Value) -> Result<serde_json::Value> {
        OrganizationAuthority::capture()?
            .context("ORGANIZATION_GOVERNED_CHANNEL_REQUIRED")?
            .wiki_job_request(request)
    }
    pub fn bind_wiki_job(&self, job: serde_json::Value) -> Result<serde_json::Value> {
        self.verify()?;
        self.organization
            .as_ref()
            .context("ORGANIZATION_GOVERNED_CHANNEL_REQUIRED")?
            .wiki_job_request(
                serde_json::json!({"operation":"wiki.job.bind","scope":self.scope,"job":job}),
            )
    }
    pub fn organization_launch_required() -> Result<bool> {
        Ok(OrganizationAuthority::capture()?.is_some())
    }
    /// A root-authenticated fixed reader may observe the publisher's existing data
    /// identity, but never initialize it or install it as the reader's caller scope.
    pub fn observe_publication_data_scope(
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
        expected: &IntegrationOwner,
    ) -> Result<(IntegrationScope, NativeIdentity)> {
        workspace.verify_private_directory()?;
        Self::observe_existing_data_scope(
            profile,
            workspace,
            expected,
            "shared-publication-fixed-read-v1",
        )
    }

    /// Observe this OS user's existing native data identity. The caller retains
    /// its own PDP and frozen workspace owner; this never creates authority.
    /// Ordinary execution workspaces need not be private profile directories.
    pub fn observe_existing_data_scope(
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
        expected: &IntegrationOwner,
        configuration_revision: &str,
    ) -> Result<(IntegrationScope, NativeIdentity)> {
        profile.verify_private_directory()?;
        let profile_identity = profile.directory_identity()?;
        let mut scope = IntegrationScope {
            account_id: identity("account-profile", &profile_identity),
            target_id: identity("native-target", &profile_identity),
            workspace_id: IntegrationNullable::Null,
            organization_id: None,
            identity_generation: "native-profile-handshake".into(),
            target_revision: configuration_revision.into(),
        };
        let identity = NativeIdentity::observe(profile, &scope)?
            .context("INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED")?;
        let snapshot = identity.snapshot(profile)?;
        ensure!(snapshot.enabled, "INTEGRATION_IDENTITY_REVOKED");
        scope.workspace_id = IntegrationNullable::Value(self::identity(
            "native-workspace",
            &format!("{profile_identity}\0{}", workspace.directory_identity()?),
        ));
        scope.organization_id = expected.organization_id.clone();
        scope.identity_generation = snapshot.generation;
        ensure!(
            IntegrationOwner::from(&scope) == *expected,
            "KNOWLEDGE_PUBLISHER_DATA_OWNER_MISMATCH"
        );
        Ok((scope, identity))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn shared_publication_request(
        &self,
        owner: &IntegrationOwner,
        publication_id: &str,
        version: u64,
        usage: &str,
        request_id: &str,
        expected_sha256: Option<&str>,
        retrieval: Option<(&str, usize, u64)>,
    ) -> Result<(serde_json::Value, Option<std::fs::File>)> {
        self.verify()?;
        ensure!(
            version > 0
                && matches!(usage, "read" | "use")
                && (owner.account_id != self.scope.account_id
                    || (owner.target_id == self.scope.target_id
                        && owner.workspace_id != self.scope.workspace_id
                        && matches!(owner.workspace_id, IntegrationNullable::Value(_))
                        && matches!(self.scope.workspace_id, IntegrationNullable::Value(_))))
                && matches!(
                    &self.scope.organization_id,
                    Some(IntegrationNullable::Value(_))
                )
                && owner.organization_id == self.scope.organization_id,
            "KNOWLEDGE_SHARED_REFERENCE_DENIED"
        );
        let result = self.organization.as_ref().context("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE")?
            .publication_request(serde_json::json!({"operation":if expected_sha256.is_some() {"sharedPublication.verify"} else {"sharedPublication.open"},
                "requestId":request_id,"readerScope":self.scope,"owner":owner,"publicationId":publication_id,
                "version":version,"usage":usage,"expectedSha256":expected_sha256,
                "retrieval":retrieval.map(|(query,limit,observed)|serde_json::json!({"query":query,"limit":limit,"observedAtMs":observed}))}))?;
        self.verify()?;
        Ok(result)
    }
    pub fn shared_publication_directory_request(
        &self,
        operation: &str,
        request_id: &str,
        mut fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(serde_json::Value, Option<std::fs::File>)> {
        self.verify()?;
        ensure!(
            matches!(
                operation,
                "sharedPublication.directory.inspect"
                    | "sharedPublication.directory.list"
                    | "sharedPublication.directory.verify"
                    | "sharedPublication.directory.check"
            ) && matches!(
                self.scope.organization_id,
                Some(IntegrationNullable::Value(_))
            ),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        fields.insert("operation".into(), operation.into());
        fields.insert("requestId".into(), request_id.into());
        fields.insert("readerScope".into(), serde_json::to_value(&self.scope)?);
        let result = self
            .organization
            .as_ref()
            .context("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE")?
            .publication_request(serde_json::Value::Object(fields))?;
        self.verify()?;
        Ok(result)
    }
    /// Native receipt reconciliation never initializes an absent profile identity.
    pub fn capture_existing(
        profile_path: &Path,
        workspace_path: &Path,
        connection_generation: &str,
        configuration_revision: &str,
    ) -> Result<Self> {
        let _ = connection_generation;
        Self::capture_profile(profile_path, workspace_path, configuration_revision, false)
    }

    pub fn capture(
        profile_path: &Path,
        workspace_path: &Path,
        _connection_generation: &str,
        configuration_revision: &str,
    ) -> Result<Self> {
        Self::capture_profile(profile_path, workspace_path, configuration_revision, true)
    }

    fn capture_profile(
        profile_path: &Path,
        workspace_path: &Path,
        configuration_revision: &str,
        initialize_absent: bool,
    ) -> Result<Self> {
        ensure!(
            profile_path.is_absolute() && workspace_path.is_absolute(),
            "native integration paths must be absolute"
        );
        let profile = PrivateDirectory::open_existing(profile_path)?;
        profile.verify_private_directory()?;
        let profile_identity = profile.directory_identity()?;
        let workspace_path = workspace_path
            .canonicalize()
            .context("workspace unavailable")?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let workspace_identity = workspace.directory_identity()?;
        let organization = OrganizationAuthority::capture()?;
        let organization_id = organization
            .as_ref()
            .map(|authority| authority.organization_id.clone());
        let global_scope = IntegrationScope {
            account_id: identity("account-profile", &profile_identity),
            // This names the native profile endpoint, not a client target alias.
            target_id: identity("native-target", &profile_identity),
            workspace_id: IntegrationNullable::Null,
            identity_generation: "native-profile-handshake".into(),
            target_revision: configuration_revision.into(),
            organization_id: None,
        };
        global_scope.validate()?;
        // This metadata is established only during the authenticated, opted-in
        // native handshake. Ordinary reads never initialize or repair it.
        let principal_identity = match NativeIdentity::observe(&profile, &global_scope)? {
            Some(identity) => identity,
            None => {
                ensure!(
                    initialize_absent,
                    "INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED"
                );
                NativeIdentity::initialize(&profile, &global_scope, "native-profile-identity-v1")?
            }
        };
        let snapshot = principal_identity.snapshot(&profile)?;
        ensure!(snapshot.enabled, "INTEGRATION_IDENTITY_REVOKED");
        let mut scope = IntegrationScope {
            account_id: global_scope.account_id,
            target_id: global_scope.target_id,
            workspace_id: IntegrationNullable::Value(identity(
                "native-workspace",
                &format!("{profile_identity}\0{workspace_identity}"),
            )),
            identity_generation: snapshot.generation,
            target_revision: configuration_revision.into(),
            organization_id: organization_id.map(IntegrationNullable::Value),
        };
        scope.validate()?;
        let lifecycle_revision_name = lifecycle_revision::name(&scope)?;
        let pinned_revision = lifecycle_revision::read(&profile, &scope, &lifecycle_revision_name)?;
        let lifecycle_revision_required = pinned_revision.is_some();
        if let Some(revision) = pinned_revision {
            scope.target_revision = revision;
        }
        let context = Self {
            profile,
            profile_path: profile_path.to_path_buf(),
            profile_identity,
            workspace,
            workspace_path,
            workspace_identity,
            identity: principal_identity,
            scope,
            lifecycle_revision_name,
            lifecycle_revision_required,
            organization,
            #[cfg(any(test, feature = "native-identity-test-hooks"))]
            identity_checks: std::sync::atomic::AtomicUsize::new(0),
        };
        context.verify()?;
        Ok(context)
    }

    /// Read the current native source-authorization epoch; never initialize it.
    pub fn source_authority_epoch(&self) -> Result<(String, u64)> {
        let snapshot = self.verify_current_identity()?;
        Ok((snapshot.generation, snapshot.revision))
    }

    pub fn scope(&self) -> &IntegrationScope {
        &self.scope
    }

    /// Enforce the current root-owned organization resource policy immediately
    /// before a new read or side effect. Personal deployments keep their path.
    pub fn authorize_organization_resource(
        &self,
        action: &str,
        resource_id: &str,
        request_id: &str,
    ) -> Result<()> {
        self.verify()?;
        if let Some(authority) = &self.organization {
            authority.authorize(action, resource_id, request_id)?;
        }
        Ok(())
    }

    pub fn organization_policy_revision(&self) -> Result<Option<u64>> {
        self.organization
            .as_ref()
            .map(|authority| authority.verify())
            .transpose()
    }
    pub fn organization_budget_request(
        &self,
        operation: &str,
        action: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.verify()?;
        let authority = self
            .organization
            .as_ref()
            .context("ORGANIZATION_BUDGET_AUTHORITY_REQUIRED")?;
        let result = authority.budget_request(operation, action)?;
        self.verify()?;
        Ok(result)
    }
    /// Only a resolved Native configuration and its actual Provider endpoint belong here.
    /// Public model labels and a caller-provided origin are never sufficient authority.
    pub fn authorize_organization_model(
        &self,
        model: &kcoder_types::ModelConfigurationSummary,
        endpoint: &str,
        request_id: &str,
    ) -> Result<()> {
        self.verify()?;
        if let Some(authority) = &self.organization {
            let provider = model
                .provider_id
                .as_deref()
                .context("ORGANIZATION_MODEL_UNAVAILABLE")?;
            let url = url::Url::parse(endpoint)
                .map_err(|_| anyhow::anyhow!("ORGANIZATION_MODEL_ENDPOINT_INVALID"))?;
            ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none(),
                "ORGANIZATION_MODEL_ENDPOINT_INVALID"
            );
            let origin = url.origin().ascii_serialization();
            let resource = format!(
                "model:{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "organization-model-v1",
                    provider,
                    &model.model_id,
                    &origin,
                    &model.revision,
                ))?)
            );
            authority.authorize_model(
                organization::OrganizationModelIdentity {
                    provider,
                    model: &model.model_id,
                    origin: &origin,
                    revision: &model.revision,
                    resource: &resource,
                    workspace: self
                        .scope
                        .workspace_id
                        .as_ref()
                        .context("ORGANIZATION_WORKSPACE_REQUIRED")?,
                },
                request_id,
            )?;
        }
        self.verify()
    }
    /// Capture an independent native handle set for this owner's long-lived service.
    /// This preserves the persistent principal epoch, not a transport's lifetime.
    pub fn recapture_for_owned_service(&self) -> Result<Self> {
        self.verify()?;
        let captured = Self::capture(
            &self.profile_path,
            &self.workspace_path,
            "owned-native-service",
            &self.scope.target_revision,
        )?;
        self.validate_scope(captured.scope())?;
        Ok(captured)
    }

    /// Retain the owned context for another checked operation. The context
    /// supplies handles only. Its next use still verifies current revocation.
    pub fn retain_for_checked_operation(self: &Arc<Self>) -> Result<Arc<Self>> {
        if self.lifecycle_revision_required {
            return Ok(self.clone());
        }
        // Legacy contexts still recapture in case a lifecycle was just pinned.
        self.recapture_for_owned_service().map(Arc::new)
    }
    pub fn profile_path(&self) -> Result<&Path> {
        self.verify()?;
        Ok(&self.profile_path)
    }
    /// A captured locator only. Storage operations must validate their own live boundary.
    pub fn captured_profile_path(&self) -> &Path {
        &self.profile_path
    }
    pub fn workspace_path(&self) -> Result<&Path> {
        self.verify()?;
        Ok(&self.workspace_path)
    }
    pub fn workspace_directory_identity(&self) -> Result<String> {
        self.verify()?;
        self.workspace.directory_identity()
    }
    pub fn validate_scope(&self, requested: &IntegrationScope) -> Result<()> {
        self.verify()?;
        self.check_captured_scope(requested)
    }

    /// Compare labels only. The caller must still verify the live context at its effect boundary.
    pub fn check_captured_scope(&self, requested: &IntegrationScope) -> Result<()> {
        use kcoder_types::integrations::core::IntegrationOwner;
        requested.validate()?;
        ensure!(
            IntegrationOwner::from(requested) == IntegrationOwner::from(&self.scope)
                && requested.identity_generation == self.scope.identity_generation
                && requested.target_revision == self.scope.target_revision,
            "INTEGRATION_SCOPE_MISMATCH"
        );
        Ok(())
    }

    pub fn refresh_configuration_revision(&mut self, revision: String) -> Result<()> {
        self.verify()?;
        let mut next = self.scope.clone();
        // A negotiated connection lifecycle is independent of task/model settings.
        // Unpinned legacy contexts retain their original explicit revision checks.
        let pinned =
            lifecycle_revision::read(&self.profile, &self.scope, &self.lifecycle_revision_name)?;
        self.lifecycle_revision_required |= pinned.is_some();
        next.target_revision = pinned.unwrap_or(revision);
        next.validate()?;
        self.scope = next;
        Ok(())
    }

    pub fn profile(&self) -> Result<&PrivateDirectory> {
        // TODO(channel-latency): split held-handle access from explicit boundary
        // checks after auditing callers; never memoize identity revocation.
        self.verify()?;
        Ok(&self.profile)
    }

    pub fn verify(&self) -> Result<()> {
        self.verify_current_identity().map(|_| ())
    }

    #[cfg(any(test, feature = "native-identity-test-hooks"))]
    pub fn identity_checks(&self) -> usize {
        self.identity_checks
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn verify_current_identity(&self) -> Result<NativeIdentitySnapshot> {
        #[cfg(any(test, feature = "native-identity-test-hooks"))]
        self.identity_checks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Some(authority) = &self.organization {
            authority.verify()?;
        } else {
            OrganizationAuthority::verify_personal_launch()?;
        }
        self.profile.verify_private_directory()?;
        let current_profile = PrivateDirectory::open_existing(&self.profile_path)?;
        current_profile.verify_private_directory()?;
        let current_workspace = PrivateDirectory::open_existing(&self.workspace_path)?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && current_profile.directory_identity()? == self.profile_identity
                && self.workspace.directory_identity()? == self.workspace_identity
                && current_workspace.directory_identity()? == self.workspace_identity,
            "native integration owner changed"
        );
        let snapshot = self.identity.snapshot(&self.profile)?;
        ensure!(
            snapshot.enabled && snapshot.generation == self.scope.identity_generation,
            "INTEGRATION_IDENTITY_REVOKED"
        );
        let pinned =
            lifecycle_revision::read(&self.profile, &self.scope, &self.lifecycle_revision_name)?;
        ensure!(
            (!self.lifecycle_revision_required || pinned.is_some())
                && pinned.is_none_or(|revision| revision == self.scope.target_revision),
            "INTEGRATION_LIFECYCLE_REVISION_CHANGED"
        );
        Ok(snapshot)
    }
}

fn identity(domain: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"kcoder-native-integrations-v1\0");
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(value.as_bytes());
    format!("native-{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::integrations::core::IntegrationOwner;
    use std::ffi::OsStr;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_or_create(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        (temp, profile, workspace)
    }

    #[test]
    fn existing_capture_never_initializes_an_absent_identity_or_repairs_partial_state() {
        let (_temp, profile, workspace) = fixture();
        let before = std::fs::read_dir(&profile).unwrap().count();
        let error = NativeIntegrationContext::capture_existing(
            &profile,
            &workspace,
            "read-only-observation",
            "original-revision",
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED"
        );
        assert_eq!(std::fs::read_dir(&profile).unwrap().count(), before);
        let original = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "actual-native-handshake",
            "original-revision",
        )
        .unwrap();
        let mut records = Vec::new();
        for directory in std::fs::read_dir(&profile).unwrap() {
            let path = directory.unwrap().path().join("native-identity.jsonl");
            if path.is_file() {
                records.push(path);
            }
        }
        assert_eq!(records.len(), 1);
        std::fs::remove_file(&records[0]).unwrap();
        assert!(
            NativeIntegrationContext::capture_existing(
                &profile,
                &workspace,
                "read-only-after-damage",
                "original-revision"
            )
            .is_err()
        );
        assert!(
            !records[0].exists(),
            "observation must not repair an identity anchor"
        );
        assert!(original.verify().is_err());
    }

    #[test]
    fn owner_is_native_and_stable_across_connection_generations() {
        let (_temp, profile, workspace) = fixture();
        let first =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .unwrap();
        let second =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-2", "config-2")
                .unwrap();
        assert_eq!(
            IntegrationOwner::from(first.scope()),
            IntegrationOwner::from(second.scope())
        );
        assert_eq!(
            first.scope().identity_generation,
            second.scope().identity_generation
        );
        assert!(first.scope().organization_id.is_none());
        first.profile().unwrap();
    }

    #[test]
    fn profile_revocation_reaches_existing_workspaces_and_prevents_reconnect() {
        let (temp, profile, workspace) = fixture();
        let first =
            NativeIntegrationContext::capture(&profile, &workspace, "transport-one", "config-one")
                .unwrap();
        PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("workspace-two"))
            .unwrap();
        let second = NativeIntegrationContext::capture(
            &profile,
            &temp.path().join("workspace-two"),
            "transport-two",
            "config-one",
        )
        .unwrap();
        assert_eq!(
            first.scope().identity_generation,
            second.scope().identity_generation
        );
        assert_ne!(first.scope().workspace_id, second.scope().workspace_id);
        let original = first.identity.snapshot(&first.profile).unwrap();
        assert_eq!(
            second.source_authority_epoch().unwrap(),
            (original.generation.clone(), original.revision)
        );
        first
            .identity
            .disable(
                &first.profile,
                "explicit-account-disable",
                original.revision,
                1000,
            )
            .unwrap();
        assert!(first.verify().is_err());
        assert!(second.verify().is_err());
        assert!(second.source_authority_epoch().is_err());
        assert!(
            NativeIntegrationContext::capture(&profile, &workspace, "new-transport", "config-one")
                .is_err()
        );
    }

    #[test]
    fn owned_service_recapture_keeps_native_identity_and_original_workspace() {
        let (_temp, profile, workspace) = fixture();
        let first =
            NativeIntegrationContext::capture(&profile, &workspace, "transport-one", "config-one")
                .unwrap();
        let service = first.recapture_for_owned_service().unwrap();
        assert_eq!(service.scope(), first.scope());
        drop(first);
        service.verify().unwrap();
    }

    #[test]
    fn scope_cannot_be_reused_for_a_different_native_profile() {
        let (_temp, profile, workspace) = fixture();
        let (other_temp, other_profile, _) = fixture();
        let first =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .unwrap();
        let second = NativeIntegrationContext::capture(
            &other_profile,
            &workspace,
            "connection-1",
            "config-1",
        )
        .unwrap();
        assert_ne!(first.scope().account_id, second.scope().account_id);
        assert_ne!(first.scope().workspace_id, second.scope().workspace_id);
        drop(other_temp);
        assert!(second.verify().is_err());
    }

    #[test]
    fn replaced_profile_is_not_adopted_even_when_empty() {
        let (temp, profile, workspace) = fixture();
        let context =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .unwrap();
        std::fs::rename(&profile, temp.path().join("old-profile")).unwrap();
        PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("profile"))
            .unwrap();
        assert!(context.verify().is_err());
    }

    #[test]
    fn replaced_workspace_does_not_inherit_the_previous_scope() {
        let (temp, profile, workspace) = fixture();
        let context =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .unwrap();
        std::fs::rename(&workspace, temp.path().join("old-workspace")).unwrap();
        PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        assert!(context.verify().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exposed_profile_permissions_are_rejected_without_chmod_repair() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, profile, workspace) = fixture();
        std::fs::set_permissions(&profile, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .is_err()
        );
        assert_eq!(
            std::fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
