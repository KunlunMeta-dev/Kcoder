//! First-party task infrastructure has no platform or background execution grant.
use crate::app_server::QueryEngine;
use anyhow::{Context, Result};

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(in crate::app_server) fn guard_stdio_against_legacy_host(
    origin: &QueryEngine,
) -> Result<Option<kcoder_config::VerifiedPrivateLease>> {
    use kcoder_native_scope::ResourceOrganizationPolicy;
    use kcoder_state::{
        domain_storage::{DomainStorageGuard, StorageDomain},
        integrations::core::service_leases::IntegrationServiceLeaseStore,
        profile_resources::ProfileResourceContext,
    };
    use std::ffi::OsStr;
    let Some(settings) = origin.settings_persistence_path() else {
        return Ok(None);
    };
    let profile = settings
        .parent()
        .context("APP_SERVER_HOST_PROFILE_REQUIRED")?;
    let policy = ResourceOrganizationPolicy::capture()?;
    policy.revision()?;
    let resources =
        ProfileResourceContext::capture(profile, &origin.state.cwd(), policy.organization_id())?;
    let Some(storage) = DomainStorageGuard::observe(
        resources.profile(),
        resources.scope(),
        StorageDomain::Services,
    )?
    else {
        return Ok(None);
    };
    let store = IntegrationServiceLeaseStore::open_in(
        &storage.directory(resources.profile())?,
        OsStr::new("leases"),
        resources.scope(),
    )?;
    store.guard_stdio_against_legacy_host()
}
