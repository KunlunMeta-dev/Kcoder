//! Bind integration identity to native profile/workspace handles, never RPC labels.
use super::{NativeIdentity, native_identity::NativeIdentitySnapshot};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_config::profile_identity::ProfileIdentity;
use kcoder_config::workspace_identity::WorkspaceIdentity;
use kcoder_types::diagnostic_cause::coded_error;
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
#[path = "native_context/resource_policy.rs"]
mod resource_policy;
pub use resource_policy::ResourceOrganizationPolicy;

/// An in-process capability captured by the account-owned app-server.
/// Gateway aliases and caller-supplied scope values cannot construct its identity.
pub struct NativeIntegrationContext {
    profile: PrivateDirectory,
    profile_path: PathBuf,
    profile_identity: String,
    workspace: PrivateDirectory,
    workspace_path: PathBuf,
    workspace_identity: String,
    logical_workspace: WorkspaceIdentity,
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
    pub(super) fn observe_data_lifecycle_revision(
        profile: &PrivateDirectory,
        scope: &mut IntegrationScope,
    ) -> Result<Option<String>> {
        let name = lifecycle_revision::name(scope)?;
        let revision = lifecycle_revision::read(profile, scope, &name)?;
        if let Some(revision) = &revision {
            scope.target_revision = revision.clone();
        }
        scope.validate()?;
        Ok(revision)
    }
    /// Observe existing global profile facts without opening a workspace or
    /// initializing storage. A disabled snapshot stays disabled; neither the
    /// returned scope nor absence grants runtime or initialization authority.
    pub fn observe_global_profile(
        profile: &PrivateDirectory,
        configuration_revision: &str,
    ) -> Result<Option<(IntegrationScope, NativeIdentity, NativeIdentitySnapshot)>> {
        let logical_profile = ProfileIdentity::observe(profile)?;
        let mut scope = global_profile_scope(&logical_profile, configuration_revision)?;
        let Some(identity) = NativeIdentity::observe(profile, &scope)? else {
            logical_profile.verify(profile)?;
            return Ok(None);
        };
        let snapshot = identity.snapshot(profile)?;
        scope.identity_generation = snapshot.generation.clone();
        logical_profile.verify(profile)?;
        Ok(Some((scope, identity, snapshot)))
    }

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
        profile.verify_config_root_directory()?;
        let logical_profile = ProfileIdentity::observe(profile)?;
        let profile_seed = logical_profile.logical_seed();
        let logical_workspace = WorkspaceIdentity::observe(profile, workspace)?;
        let mut scope = global_profile_scope(&logical_profile, configuration_revision)?;
        let identity = NativeIdentity::observe(profile, &scope)?
            .context("INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED")?;
        let snapshot = identity.snapshot(profile)?;
        ensure!(snapshot.enabled, "INTEGRATION_IDENTITY_REVOKED");
        scope.workspace_id = IntegrationNullable::Value(self::identity(
            "native-workspace",
            &format!("{profile_seed}\0{}", logical_workspace.logical_seed()),
        ));
        logical_profile.verify(profile)?;
        logical_workspace.verify(profile, workspace)?;
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
        profile.verify_config_root_directory()?;
        let profile_identity = profile.directory_identity()?;
        let logical_profile = ProfileIdentity::observe(&profile)?;
        let profile_seed = logical_profile.logical_seed();
        let workspace_path = workspace_path
            .canonicalize()
            .context("workspace unavailable")?;
        let workspace = PrivateDirectory::open_existing(&workspace_path)?;
        let workspace_identity = workspace.directory_identity()?;
        let logical_workspace = WorkspaceIdentity::observe(&profile, &workspace)?;
        let organization = OrganizationAuthority::capture()?;
        let organization_id = organization
            .as_ref()
            .map(|authority| authority.organization_id.clone());
        let global_scope = global_profile_scope(&logical_profile, configuration_revision)?;
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
                &format!("{profile_seed}\0{}", logical_workspace.logical_seed()),
            )),
            identity_generation: snapshot.generation,
            target_revision: configuration_revision.into(),
            organization_id: organization_id.map(IntegrationNullable::Value),
        };
        logical_profile.verify(&profile)?;
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
            logical_workspace,
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
                .map_err(coded_error("ORGANIZATION_MODEL_ENDPOINT_INVALID"))?;
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

    /// Observe related records through the same held profile. Recheck live
    /// identity after the read before using any of its observations.
    pub fn observe_live_profile<T>(
        &self,
        observe: impl FnOnce(&PrivateDirectory) -> Result<T>,
    ) -> Result<T> {
        self.verify()?;
        let observed = observe(&self.profile)?;
        self.verify()?;
        Ok(observed)
    }

    /// Full identity verification: blocking filesystem I/O (path re-resolution,
    /// identity snapshot and lifecycle revision reads). Async callers must
    /// run it in a blocking section and should verify once at a request's start
    /// and once at its end, comparing only captured scope labels and held
    /// handles in between. The result is never cached as an allow verdict.
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
        let _current_profile =
            PrivateDirectory::reopen_with_identity(&self.profile_path, &self.profile_identity)
                .context("native integration owner changed")?;
        let _current_workspace =
            PrivateDirectory::reopen_with_identity(&self.workspace_path, &self.workspace_identity)
                .context("native integration owner changed")?;
        self.logical_workspace
            .verify(&self.profile, &self.workspace)?;
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
    kcoder_integration_storage::profile_resources::profile_resource_identity(domain, value)
}

fn global_profile_scope(
    profile: &ProfileIdentity,
    configuration_revision: &str,
) -> Result<IntegrationScope> {
    let seed = profile.logical_seed();
    let scope = IntegrationScope {
        account_id: identity("account-profile", seed),
        // This names the native profile endpoint, not a client target alias.
        target_id: identity("native-target", seed),
        workspace_id: IntegrationNullable::Null,
        organization_id: None,
        identity_generation: "native-profile-handshake".into(),
        target_revision: configuration_revision.into(),
    };
    scope.validate()?;
    Ok(scope)
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
    fn live_profile_read_reuses_the_handle_and_rejects_revocation_before_returning() -> Result<()> {
        let (_owned, profile_path, workspace_path) = fixture();
        let context = NativeIntegrationContext::capture(
            &profile_path,
            &workspace_path,
            "owned-profile-read",
            "configuration-1",
        )?;
        let before = context.identity_checks();
        let directory_identity = context.observe_live_profile(|profile| {
            assert_eq!(context.identity_checks(), before + 1);
            profile.directory_identity()
        })?;
        assert_eq!(directory_identity, context.profile_identity);
        assert_eq!(context.identity_checks(), before + 2);

        let revoked = context.observe_live_profile(|profile| {
            let revision = context.identity.snapshot(profile)?.revision;
            context
                .identity
                .disable(profile, "revoke-during-output-read", revision, 1000)?;
            Ok(())
        });
        assert_eq!(
            revoked.unwrap_err().to_string(),
            "INTEGRATION_IDENTITY_REVOKED"
        );
        assert!(
            context
                .observe_live_profile(|_| -> Result<()> { panic!("revoked read started") })
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn global_profile_observation_is_pure_and_requires_no_workspace() -> Result<()> {
        let owned = tempfile::tempdir()?;
        let profile = PrivateDirectory::open_existing(owned.path())?;
        assert!(
            NativeIntegrationContext::observe_global_profile(&profile, "offline-read")?.is_none()
        );
        assert_eq!(std::fs::read_dir(owned.path())?.count(), 0);
        let logical = ProfileIdentity::observe(&profile)?;
        let scope = global_profile_scope(&logical, "original-revision")?;
        let identity = NativeIdentity::initialize(&profile, &scope, "owned-global-initialization")?;
        let expected = identity.snapshot(&profile)?;
        let before = std::fs::read_dir(owned.path())?.count();
        let (observed, original, snapshot) =
            NativeIntegrationContext::observe_global_profile(&profile, "offline-read")?.unwrap();
        assert_eq!(
            IntegrationOwner::from(&observed),
            IntegrationOwner::from(&scope)
        );
        assert!(matches!(observed.workspace_id, IntegrationNullable::Null));
        assert!(observed.organization_id.is_none());
        assert_eq!(observed.identity_generation, expected.generation);
        assert_eq!(snapshot, expected);
        assert_eq!(original.snapshot(&profile)?, expected);
        assert_eq!(std::fs::read_dir(owned.path())?.count(), before);
        Ok(())
    }

    #[test]
    fn global_profile_observation_preserves_revocation_without_runtime_capture() -> Result<()> {
        let (_owned, profile_path, workspace_path) = fixture();
        let context = NativeIntegrationContext::capture(
            &profile_path,
            &workspace_path,
            "owned-connection",
            "configuration-1",
        )?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        let before = context.identity.snapshot(&profile)?;
        let disabled =
            context
                .identity
                .disable(&profile, "original-revocation", before.revision, 1000)?;
        assert!(context.verify().is_err());
        let error = NativeIntegrationContext::capture_existing(
            &profile_path,
            &workspace_path,
            "reconnect",
            "configuration-1",
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "INTEGRATION_IDENTITY_REVOKED");
        drop(context);
        std::fs::remove_dir(&workspace_path)?;
        let (scope, identity, snapshot) =
            NativeIntegrationContext::observe_global_profile(&profile, "offline-read")?.unwrap();
        assert_eq!(snapshot, disabled);
        assert!(!snapshot.enabled);
        assert_eq!(scope.identity_generation, disabled.generation);
        assert_eq!(identity.snapshot(&profile)?, disabled);
        assert!(!workspace_path.exists());
        Ok(())
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
    fn formal_relocation_preserves_context_owner_and_workspace_with_new_physical_root() -> Result<()>
    {
        let (owned, profile, workspace) = fixture();
        let first = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "source-connection",
            "source-configuration",
        )?;
        let parent = PrivateDirectory::open_existing(owned.path())?;
        let target = parent.create_private_child(OsStr::new("relocated-profile"))?;
        let target_path = owned.path().join("relocated-profile");
        for entry in std::fs::read_dir(&profile)? {
            let entry = entry?;
            let destination = target_path.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                target.create_private_child(&entry.file_name())?;
                for file in std::fs::read_dir(entry.path())? {
                    let file = file?;
                    std::fs::copy(file.path(), destination.join(file.file_name()))?;
                }
            } else {
                std::fs::copy(entry.path(), destination)?;
            }
        }
        assert!(
            NativeIntegrationContext::capture_existing(
                &target_path,
                &workspace,
                "raw-copy-reader",
                "source-configuration",
            )
            .is_err()
        );
        let snapshot = first.identity.snapshot(&first.profile)?;
        let mut source_scope = first.scope.clone();
        source_scope.workspace_id = IntegrationNullable::Null;
        source_scope.organization_id = None;
        first.identity.relocate(
            &first.profile,
            &target,
            &source_scope,
            "move-profile",
            &snapshot,
        )?;
        let relocated = NativeIntegrationContext::capture_existing(
            &target_path,
            &workspace,
            "target-connection",
            "source-configuration",
        )?;
        assert_eq!(relocated.scope(), first.scope());
        assert_ne!(relocated.profile_identity, first.profile_identity);
        relocated.verify()?;
        first.verify()?;
        relocated.identity.disable(
            &relocated.profile,
            "revoke-at-new-root",
            snapshot.revision,
            2000,
        )?;
        assert!(relocated.verify().is_err());
        assert!(
            NativeIntegrationContext::capture_existing(
                &target_path,
                &workspace,
                "after-revocation",
                "source-configuration",
            )
            .is_err()
        );
        Ok(())
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
}
