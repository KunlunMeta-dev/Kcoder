//! A receiving receipt fixes data provenance; target project authority remains independent.
use super::*;
impl PluginMigrationStore {
    pub(super) fn authorize_received_capture(
        &self,
        job: &Job,
        preview: Option<&str>,
    ) -> Result<()> {
        ensure!(
            job.claim.is_none(),
            "plugin_migration_claimed_by_another_owner"
        );
        match (
            job.binding
                .as_ref()
                .and_then(|binding| binding.received.as_ref()),
            preview,
        ) {
            (None, None) => Ok(()),
            (Some(received), Some(expected)) if received.preview_job_id() == expected => {
                received.verify_preview()
            }
            _ => anyhow::bail!("plugin_migration_claimed_by_another_owner"),
        }
    }

    pub(super) fn capture_received(
        &self,
        dir: &PrivateDirectory,
        job: &mut Job,
        archive: &crate::source_transfer::ReceivedPluginArchive,
        cancel: &PluginCancellationToken,
    ) -> Result<()> {
        archive.verify()?;
        ensure!(
            PrivateDirectory::open_existing(archive.profile())?.directory_identity()?
                == self.profile,
            "plugin_migration_profile_changed"
        );
        let origin = archive.origin()?;
        self.reserve(dir, job, &origin.package)?;
        ensure!(
            job.attempts < 2,
            "plugin_migration_capture_retry_budget_exceeded"
        );
        job.attempts += 1;
        let relative = format!("package-{}", job.attempts);
        let package = dir.create_private_child(OsStr::new(&relative))?;
        job.package_owner = Some(package.directory_identity()?);
        job.package_relative = Some(relative);
        save(dir, job)?;
        let revision = archive.materialize(&self.package(job)?, cancel)?;
        let inspection = migration::inspect_package(&self.package(job)?, cancel)?;
        job.capabilities = inspection.capabilities;
        job.readiness = inspection.readiness;
        job.pending = inspection.pending;
        if !inspection.compatible {
            job.stage = PluginMigrationStage::Pending;
            return Ok(());
        }
        ensure!(
            inspection.name == origin.name,
            "plugin_migration_manifest_identity_changed"
        );
        self.verify_target_project(job)?;
        cancelled(cancel)?;
        job.intended = Some(revision.clone());
        job.package = Some(revision);
        job.stage = PluginMigrationStage::Ready;
        Ok(())
    }
}
