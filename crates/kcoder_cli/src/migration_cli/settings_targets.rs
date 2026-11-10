//! A saved Native target binding, never current CLI defaults, selects settings writers.
use super::{context::Context, *};
use kcoder_config::{ConfigScope, FolderTrust, FolderTrustStore};
use kcoder_migration::store::MigrationJob;

pub(super) fn verify(context: &Context, job: &MigrationJob) -> Result<()> {
    if let Some(project) = job.project_target() {
        project.verify(&context.profile)?;
        ensure!(
            project.root() == context.cwd.as_path()
                && FolderTrustStore::load(&context.profile).check(project.root())
                    == FolderTrust::Trusted,
            "migration_project_target_changed"
        );
    }
    Ok(())
}

pub(super) fn writable(context: &Context, job: &MigrationJob, fields: &[&str]) -> Result<()> {
    verify(context, job)?;
    if job.project_target().is_none() {
        return context.require_writable(fields);
    }
    let covered = |field: &str| {
        fields
            .iter()
            .any(|name| field == *name || field.starts_with(&format!("{name}.")))
    };
    ensure!(
        !context
            .loaded
            .overlay_fields
            .iter()
            .any(|field| covered(field))
            && !context
                .loaded
                .field_sources
                .iter()
                .any(|(field, scope)| covered(field)
                    && matches!(scope, ConfigScope::Executable | ConfigScope::Local)),
        "migration_target_controlled_by_overlay"
    );
    Ok(())
}
