//! Sealed project settings never inherit the user-profile publication target.
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_migration::{source_transfer::ReceivedProjectTarget, store::MigrationJob};

fn project(job: &MigrationJob) -> Option<&ReceivedProjectTarget> {
    job.project_target()
}
pub(super) fn open(
    profile: &Path,
    job: &MigrationJob,
    create: bool,
) -> Result<(ProviderTarget, McpTarget)> {
    match project(job) {
        Some(project) => Ok((
            ProviderTarget::open_project(profile, project, create)?,
            McpTarget::open_project(profile, project, create)?,
        )),
        None => Ok((ProviderTarget::open(profile)?, McpTarget::open(profile)?)),
    }
}
pub(super) fn verify(
    factory: &dyn MigrationHost,
    profile: &Path,
    job: &MigrationJob,
) -> Result<()> {
    if let Some(project) = project(job) {
        project.verify(profile)?;
        let cwd = factory
            .migration_source_roots()?
            .project
            .ok_or_else(|| anyhow::anyhow!("migration_project_target_untrusted"))?;
        ensure!(
            cwd.canonicalize()? == project.root(),
            "migration_project_target_scope_changed"
        );
        ensure!(
            PrivateDirectory::open_existing(&cwd)?.directory_identity()? == project.identity(),
            "migration_project_target_changed"
        );
    }
    Ok(())
}
pub(super) fn writable(
    factory: &dyn MigrationHost,
    profile: &Path,
    job: &MigrationJob,
    mcp: bool,
) -> Result<()> {
    verify(factory, profile, job)?;
    if let Some(project) = project(job) {
        let path = factory.migration_project_settings_path(if mcp {
            &["mcp_servers", "mcp_disabled_servers"]
        } else {
            &["providers"]
        })?;
        ensure!(
            path == project.root().join(".kcoder/settings.json"),
            "migration_project_target_scope_changed"
        );
    } else if mcp {
        factory.migration_mcp_settings_path()?;
    } else {
        factory.migration_user_settings_path()?;
    }
    Ok(())
}
pub(super) fn private_choices_allowed(job: &MigrationJob, credentials: bool) -> Result<()> {
    ensure!(
        project(job).is_none() || !credentials,
        "migration_project_credentials_unsupported"
    );
    Ok(())
}
