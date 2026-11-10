//! Only this profile's original receiving receipt can supply a static plugin package.
use super::super::*;
use super::binding::ReceivedBinding;
use crate::plugin_migration::{PluginMigrationCandidate, PluginPackageOrigin};
use kcoder_plugins::{
    PluginCancellationToken,
    migration::{PluginPackageRevision, materialize_transfer_package},
};
use std::{fs::File, path::Path};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReceivedPluginArchive {
    binding: ReceivedBinding,
    preview_job_id: String,
    preview: crate::batch::ReceivedBatchBinding,
}
struct CheckedFile<'a> {
    file: File,
    bytes: u64,
    hash: Sha256,
    limit: u64,
    cancel: &'a PluginCancellationToken,
}
impl Read for CheckedFile<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("plugin_migration_cancelled"));
        }
        let len = out.len().min(64 * 1024);
        let count = self.file.read(&mut out[..len])?;
        self.bytes = self
            .bytes
            .checked_add(count as u64)
            .ok_or_else(|| std::io::Error::other("source_transfer_budget_exceeded"))?;
        if self.bytes > self.limit {
            return Err(std::io::Error::other("source_transfer_payload_changed"));
        }
        self.hash.update(&out[..count]);
        Ok(count)
    }
}
impl IncomingTransfers {
    pub(crate) fn received_plugin_archive(
        &self,
        request: &str,
        manifest: &str,
        entry: &str,
        preview_job_id: &str,
        preview: &crate::batch::ReceivedBatchBinding,
    ) -> Result<ReceivedPluginArchive> {
        let binding = self.received_binding(request, manifest, entry)?;
        self.verify_plugin_preview(preview, preview_job_id, entry)?;
        let value = ReceivedPluginArchive {
            binding,
            preview_job_id: preview_job_id.into(),
            preview: preview.clone(),
        };
        value.origin()?.validate()?;
        Ok(value)
    }
    /// Called only inside explicit adoption. Reading the catalog does not create a job.
    pub(crate) fn received_plugin_candidate(
        &self,
        request: &str,
        manifest: &str,
        entry: &str,
        preview_job_id: &str,
        preview: &crate::batch::ReceivedBatchBinding,
    ) -> Result<PluginMigrationCandidate> {
        PluginMigrationCandidate::from_received(self.received_plugin_archive(
            request,
            manifest,
            entry,
            preview_job_id,
            preview,
        )?)
    }
}
impl ReceivedPluginArchive {
    pub(crate) fn preview_job_id(&self) -> &str {
        &self.preview_job_id
    }
    pub(crate) fn verify_mapping(
        &self,
        profile: &Path,
        mapping: Option<&kcoder_plugins::PluginProjectBinding>,
    ) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(profile)?.directory_identity()?
                == PrivateDirectory::open_existing(self.profile())?.directory_identity()?,
            "source_transfer_wrong_consumer"
        );
        let origin = self.stored_origin()?;
        ensure!(
            matches!(origin.scope.as_str(), "project" | "local") == self.preview.project.is_some(),
            "source_transfer_project_mapping_required"
        );
        match (&self.preview.project, mapping) {
            (None, None) => Ok(()),
            (Some(expected), Some(actual)) => {
                expected.verify(profile)?;
                actual.verify_for_profile(profile)?;
                let binding =
                    kcoder_plugins::PluginProjectBinding::capture(profile, expected.root())?;
                ensure!(
                    actual == &binding,
                    "source_transfer_project_mapping_changed"
                );
                Ok(())
            }
            _ => anyhow::bail!("source_transfer_project_mapping_required"),
        }
    }
    pub(crate) fn verify_preview(&self) -> Result<()> {
        self.binding.receiver()?.verify_plugin_preview(
            &self.preview,
            &self.preview_job_id,
            &self.binding.entry().id,
        )
    }
    pub(crate) fn profile(&self) -> &Path {
        self.binding.profile()
    }
    pub(crate) fn origin(&self) -> Result<PluginPackageOrigin> {
        self.binding.validate()?;
        self.stored_origin()
    }
    fn stored_origin(&self) -> Result<PluginPackageOrigin> {
        let TransferContent::PluginPackage { origin, format, .. } = &self.binding.entry().content
        else {
            anyhow::bail!("source_transfer_not_plugin");
        };
        ensure!(
            format == kcoder_plugins::migration::PLUGIN_TRANSFER_FORMAT,
            "source_transfer_plugin_format_unsupported"
        );
        origin.validate()?;
        Ok((**origin).clone())
    }
    pub(crate) fn logical_identity(&self) -> Result<String> {
        let origin = self.stored_origin()?;
        digest(&(
            "received-plugin-origin/1",
            self.binding.source(),
            origin.source,
            origin.logical_identity,
            origin.scope,
        ))
    }
    pub(crate) fn verify(&self) -> Result<()> {
        self.origin().map(drop)
    }
    pub(crate) fn materialize(
        &self,
        destination: &Path,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginPackageRevision> {
        let receiver = self.binding.validate()?;
        let origin = self.origin()?;
        let receipt = self.binding.receipt();
        let (directory, manifest) =
            receiver.ready(&receipt.request_id, self.binding.source(), receipt)?;
        let entry = find_entry(&manifest, &self.binding.entry().id)?;
        ensure!(
            entry == self.binding.entry(),
            "source_transfer_binding_changed"
        );
        let name = payload_name(entry);
        let identity = directory.portable_regular_identity(OsStr::new(&name))?;
        let file = directory.open_single_link_regular_file(OsStr::new(&name))?;
        ensure!(
            file.metadata()?.len() == entry.bytes,
            "source_transfer_payload_changed"
        );
        let mut input = CheckedFile {
            file,
            bytes: 0,
            hash: Sha256::new(),
            limit: entry.bytes,
            cancel,
        };
        let package = materialize_transfer_package(
            &mut input,
            destination,
            kcoder_plugins::InstallLimits::default(),
            cancel,
        )?;
        ensure!(
            input.bytes == entry.bytes
                && format!("{:x}", input.hash.finalize()) == entry.sha256
                && directory.portable_regular_identity(OsStr::new(&name))? == identity
                && package.files == origin.package.files
                && package.bytes == origin.package.bytes,
            "source_transfer_payload_changed"
        );
        self.binding.validate()?;
        Ok(package)
    }
}
