//! Explicit local destinations use the same native directory proof as received projects.
use super::*;
use crate::{batch::BatchSource, source_transfer::ReceivedProjectTarget};
use kcoder_config::{FolderTrust, FolderTrustStore};

impl MigrationJob {
    pub fn project_target(&self) -> Option<&ReceivedProjectTarget> {
        self.batch.as_ref()?.project_target()
    }
}

impl MigrationStore {
    fn project_profile(&self) -> Result<&Path> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        let migrations = profile.open_child(OsStr::new("migrations"), false)?;
        ensure!(
            migrations.directory_identity()? == self.directory.directory_identity()?,
            "migration_wrong_target"
        );
        Ok(&self.profile)
    }

    /// Source selection never implies a destination. The host must authorize this
    /// actual workspace separately before asking Native to seal it into a job.
    pub fn create_batch_scan_in_project(
        &self,
        inputs: Vec<BatchSource>,
        authorized_workspace: &Path,
    ) -> Result<MigrationJob> {
        self.create_batch_scan_in_project_with_resource_limits(
            inputs,
            authorized_workspace,
            Default::default(),
        )
    }

    pub fn create_batch_scan_in_project_with_resource_limits(
        &self,
        inputs: Vec<BatchSource>,
        authorized_workspace: &Path,
        limits: kcoder_types::migration_resource::MigrationResourceLimits,
    ) -> Result<MigrationJob> {
        let profile = self.project_profile()?;
        let binding = ReceivedProjectTarget::capture(profile, authorized_workspace)?;
        ensure!(
            FolderTrustStore::load(profile).check(binding.root()) == FolderTrust::Trusted,
            "migration_project_target_untrusted"
        );
        let mut job = self.freeze_batch_scan_with_resource_limits(
            &format!("mig-{}", uuid::Uuid::new_v4().simple()),
            &format!("src-{}", uuid::Uuid::new_v4().simple()),
            inputs,
            limits,
            &mut |_| true,
        )?;
        job.batch
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?
            .local_project = Some(binding);
        let _lock = self.write_lock()?;
        self.save(&job)?;
        Ok(job)
    }

    pub(super) fn verify_project_targets(
        &self,
        job: &MigrationJob,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        let project = job.project_target();
        ensure!(
            targets.provider.project_binding() == project
                && targets.mcp.project_binding() == project,
            "migration_wrong_target"
        );
        if let Some(project) = project {
            let profile = self.project_profile()?;
            project.verify(profile)?;
            ensure!(
                FolderTrustStore::load(profile).check(project.root()) == FolderTrust::Trusted,
                "migration_project_target_untrusted"
            );
        }
        Ok(())
    }
}
