//! Expert resources use the app-server profile and ordinary organization policy.
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_native_scope::ResourceOrganizationPolicy;
use kcoder_state::{
    domain_storage::{DomainStorageGuard, StorageDomain},
    integrations::resources::ResourceStore,
    profile_resources::ProfileResourceContext,
};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use std::{ffi::OsStr, path::PathBuf};

pub(in crate::app_server) struct AgentResources {
    context: ProfileResourceContext,
    policy: ResourceOrganizationPolicy,
}

impl AgentResources {
    pub(in crate::app_server) fn capture(engine: &QueryEngine) -> Result<Self> {
        let settings = engine
            .settings_persistence_path()
            .context("AGENT_RESOURCE_PROFILE_UNAVAILABLE")?;
        let policy = ResourceOrganizationPolicy::capture()?;
        let context = ProfileResourceContext::capture(
            settings
                .parent()
                .context("AGENT_RESOURCE_PROFILE_UNAVAILABLE")?,
            &engine.state.cwd(),
            policy.organization_id(),
        )?;
        Ok(Self { context, policy })
    }

    pub(in crate::app_server) fn scope(&self) -> &IntegrationScope {
        self.context.scope()
    }

    pub(in crate::app_server) fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        self.context.validate_scope(scope)?;
        self.policy.revision()?;
        Ok(())
    }

    pub(in crate::app_server) fn authorize(
        &self,
        action: &str,
        request: &str,
    ) -> Result<Option<u64>> {
        self.context.verify()?;
        let actions =
            super::resource_policy::required_actions(action).context("OFFICE_POLICY_DENIED")?;
        let revision = self.policy.revision()?;
        if let Some(revision) = revision {
            let resource =
                super::resource_policy::resource_id(&IntegrationOwner::from(self.scope()))?;
            for action in actions {
                self.policy.authorize(action, &resource, request)?;
            }
            ensure!(
                self.policy.revision()? == Some(revision),
                "OFFICE_SCOPE_CHANGED"
            );
        }
        Ok(revision)
    }

    /// Reads never initialize storage. The first explicit write uses the existing receipt.
    pub(in crate::app_server) fn store(
        &self,
        initialize: Option<&str>,
    ) -> Result<Option<(DomainStorageGuard, ResourceStore)>> {
        self.context.verify()?;
        let profile = self.context.profile();
        if let Some(guard) =
            DomainStorageGuard::observe(profile, self.scope(), StorageDomain::WorkspaceResources)?
        {
            let store = ResourceStore::open_in(
                &guard.directory(profile)?,
                OsStr::new("data"),
                IntegrationOwner::from(self.scope()),
            )?
            .context("AGENT_RESOURCE_STORE_UNAVAILABLE")?;
            return Ok(Some((guard, store)));
        }
        let Some(operation) = initialize else {
            return Ok(None);
        };
        let (guard, store) = DomainStorageGuard::initialize(
            profile,
            self.scope(),
            StorageDomain::WorkspaceResources,
            operation,
            |namespace| {
                ResourceStore::create_in(
                    namespace,
                    OsStr::new("data"),
                    IntegrationOwner::from(self.scope()),
                )
            },
        )?;
        Ok(Some((guard, store)))
    }

    pub(in crate::app_server) fn verify_store(
        &self,
        guard: &DomainStorageGuard,
        store: &ResourceStore,
    ) -> Result<()> {
        let namespace = guard.directory(self.context.profile())?;
        let directory = namespace
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            directory.directory_identity()? == store.storage_directory_identity()?,
            "AGENT_RESOURCE_STORE_CHANGED"
        );
        Ok(())
    }

    pub(in crate::app_server) fn data_path(&self) -> Result<PathBuf> {
        let namespace = DomainStorageGuard::expected_namespace_id(
            self.scope(),
            StorageDomain::WorkspaceResources,
        )?;
        Ok(self.context.profile_path().join(namespace).join("data"))
    }
}
