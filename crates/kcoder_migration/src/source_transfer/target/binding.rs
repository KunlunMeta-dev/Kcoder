//! Durable target-owned configuration provenance, never a client-supplied source grant.
use super::*;
use std::path::PathBuf;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferredConfigurationBinding {
    profile: PathBuf,
    profile_identity: String,
    target: TransferAuthority,
    source: TransferAuthority,
    receipt: TransferReceipt,
    entry: TransferEntry,
    kind: kcoder_types::migration::MigrationSourceKind,
    source_identity: String,
}
impl std::fmt::Debug for TransferredConfigurationBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferredConfigurationBinding")
            .field("request_id", &self.receipt.request_id)
            .field("entry_id", &self.entry.id)
            .finish_non_exhaustive()
    }
}
impl IncomingTransfers {
    /// The source identity is supplied by the authenticated host peer. All other
    /// provenance is read from the already committed private receiving journal.
    pub fn configuration_binding(
        &self,
        request_id: &str,
        authenticated_source: &TransferAuthority,
        entry_id: &str,
        receipt: &TransferReceipt,
    ) -> Result<TransferredConfigurationBinding> {
        let (_, manifest) = self.ready(request_id, authenticated_source, receipt)?;
        let entry = find_entry(&manifest, entry_id)?.clone();
        let TransferContent::ConfigurationInventory {
            source: kind,
            source_identity,
            ..
        } = &entry.content
        else {
            anyhow::bail!("source_transfer_not_configuration");
        };
        let kind = *kind;
        let source_identity = digest(&(
            "transferred-configuration/1",
            authenticated_source,
            kind,
            source_identity,
        ))?;
        let binding = TransferredConfigurationBinding {
            profile: self.store.profile.clone(),
            profile_identity: self.store.identity.clone(),
            target: self.store.authority.clone(),
            source: authenticated_source.clone(),
            receipt: receipt.clone(),
            entry,
            kind,
            source_identity,
        };
        binding.inventory()?;
        Ok(binding)
    }
}
impl TransferredConfigurationBinding {
    pub(crate) fn credential_source_key(&self) -> (&str, &str, &str) {
        (
            &self.receipt.request_id,
            &self.receipt.manifest_sha256,
            &self.entry.id,
        )
    }

    pub(crate) fn credential_request_matches(
        &self,
        request: &str,
        source: &super::super::TransferAuthority,
        target: &super::super::TransferAuthority,
    ) -> bool {
        self.receipt.request_id == request && &self.source == source && &self.target == target
    }

    /// Reconcile immutable received bytes without resuming a cancelled transfer or opening its source.
    pub(crate) fn credential_source_metadata(
        &self,
        profile: &Path,
    ) -> Result<kcoder_types::migration_credential_sources::MigrationSourceCredentialSource> {
        let owner = PrivateDirectory::open_existing(profile)?;
        owner.verify_private_directory()?;
        ensure!(
            owner.directory_identity()? == self.profile_identity,
            "source_transfer_wrong_consumer"
        );
        ensure!(
            self.source()? == self.kind && self.logical_identity()? == self.source_identity,
            "source_transfer_manifest_changed"
        );
        let receiver = self.receiver()?;
        let grant = receiver.recover_target(&self.receipt.request_id)?;
        ensure!(
            grant.source_authority() == &self.source
                && grant.destination().authority == self.target,
            "source_transfer_authority_changed"
        );
        let (directory, manifest) = receiver.existing(&self.receipt.request_id, &self.source)?;
        ensure!(
            self.receipt == expected_receipt(&manifest)?
                && receiver
                    .receipt(&self.receipt.request_id, &self.source)?
                    .as_ref()
                    == Some(&self.receipt)
                && find_entry(&manifest, &self.entry.id)? == &self.entry,
            "source_transfer_receipt_changed"
        );
        let TransferContent::ConfigurationInventory {
            source_binding_revision,
            source_scope,
            ..
        } = &self.entry.content
        else {
            anyhow::bail!("source_transfer_not_configuration");
        };
        ensure!(
            self.entry.bytes <= 8 * 1024 * 1024,
            "source_transfer_budget_exceeded"
        );
        let mut file =
            directory.open_single_link_regular_file(OsStr::new(&payload_name(&self.entry)))?;
        fingerprint(&mut file, self.entry.bytes, &self.entry.sha256, &mut |_| {
            true
        })?;
        Ok(
            kcoder_types::migration_credential_sources::MigrationSourceCredentialSource {
                request_id: self.receipt.request_id.clone(),
                manifest_sha256: self.receipt.manifest_sha256.clone(),
                entry_id: self.entry.id.clone(),
                source_binding_revision: source_binding_revision.clone(),
                source: self.kind,
                project_scoped: super::configuration_project_scoped(source_scope),
            },
        )
    }

    pub(crate) fn private_credential_matches(
        &self,
        context: &super::super::private_credentials::PrivateCredentialContext,
    ) -> Result<()> {
        self.inventory()?;
        let TransferContent::ConfigurationInventory {
            source_identity,
            source_binding_revision,
            ..
        } = &self.entry.content
        else {
            anyhow::bail!("private_credentials_source_not_selected")
        };
        ensure!(
            self.profile_identity == context.target_profile_identity
                && self.target == context.destination.authority
                && self.source == context.source
                && self.receipt.request_id == context.request_id
                && self.receipt.manifest_sha256 == context.manifest_sha256
                && self.entry.id == context.entry_id
                && *source_identity == context.source_identity
                && *source_binding_revision == context.source_binding_revision,
            "private_credentials_binding_changed"
        );
        Ok(())
    }
    pub fn uploaded_source(
        &self,
    ) -> Result<Option<kcoder_types::migration_source_upload::SourceUploadProvenance>> {
        self.inventory()?;
        Ok(self.entry.content.uploaded_source().cloned())
    }
    fn receiver(&self) -> Result<IncomingTransfers> {
        Ok(IncomingTransfers {
            store: Store::reopen_existing(
                &self.profile,
                &self.profile_identity,
                &self.target,
                "incoming",
            )?,
        })
    }
    /// Reopening never recreates the target identity, receiving directory or payload.
    pub fn inventory(&self) -> Result<crate::MigrationInventory> {
        ensure!(
            self.source()? == self.kind && self.logical_identity()? == self.source_identity,
            "source_transfer_manifest_changed"
        );
        let receiver = self.receiver()?;
        let (_, manifest) =
            receiver.ready(&self.receipt.request_id, &self.source, &self.receipt)?;
        ensure!(
            find_entry(&manifest, &self.entry.id)? == &self.entry,
            "source_transfer_manifest_changed"
        );
        receiver.configuration_inventory(
            &self.receipt.request_id,
            &self.source,
            &self.entry.id,
            &self.receipt,
        )
    }
    pub fn source(&self) -> Result<kcoder_types::migration::MigrationSourceKind> {
        match &self.entry.content {
            TransferContent::ConfigurationInventory { source, .. } => Ok(*source),
            _ => anyhow::bail!("source_transfer_not_configuration"),
        }
    }
    pub fn source_scope(&self) -> Result<&str> {
        match &self.entry.content {
            TransferContent::ConfigurationInventory { source_scope, .. } => Ok(source_scope),
            _ => anyhow::bail!("source_transfer_not_configuration"),
        }
    }
    /// Stable source identity remains distinct from this transfer's content revision.
    pub fn logical_identity(&self) -> Result<String> {
        match &self.entry.content {
            TransferContent::ConfigurationInventory {
                source_identity,
                source,
                ..
            } => digest(&(
                "transferred-configuration/1",
                &self.source,
                source,
                source_identity,
            )),
            _ => anyhow::bail!("source_transfer_not_configuration"),
        }
    }
    pub(crate) fn kind(&self) -> kcoder_types::migration::MigrationSourceKind {
        self.kind
    }
    pub(crate) fn stable_identity(&self) -> &str {
        &self.source_identity
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "source_transfer_wrong_consumer"
        );
        let expected = profile.open_child(OsStr::new("migrations"), false)?;
        parent.verify_private_directory()?;
        ensure!(
            expected.directory_identity()? == parent.directory_identity()?,
            "source_transfer_wrong_consumer"
        );
        Ok(())
    }
    pub(crate) fn validate_item(&self, planned: &crate::NormalizedItem) -> Result<()> {
        let inventory = self.inventory()?;
        let original = inventory
            .items
            .iter()
            .find(|item| {
                item.preview.category == planned.preview.category
                    && item.preview.source_name == planned.preview.source_name
                    && item.provider.is_some() == planned.provider.is_some()
                    && item.template.is_some() == planned.template.is_some()
                    && item.mcp.is_some() == planned.mcp.is_some()
            })
            .context("migration_source_changed")?;
        if let Some(provider) = &planned.provider {
            ensure!(
                original
                    .provider
                    .as_ref()
                    .is_some_and(|value| value.api_format == provider.api_format),
                "migration_source_changed"
            );
            ensure!(
                !original
                    .preview
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import()
                        && !crate::providers::resolution_can_fix(issue)),
                "migration_item_requires_resolution"
            );
        } else if planned.template.is_some() {
            ensure!(
                original.template == planned.template,
                "migration_source_changed"
            );
        }
        Ok(())
    }
    pub(crate) fn validate_settings_scope(
        &self,
        project: Option<&super::received::ReceivedProjectTarget>,
    ) -> Result<()> {
        ensure!(
            super::configuration_project_scoped(self.source_scope()?) == project.is_some(),
            "source_transfer_project_mapping_required"
        );
        if let Some(project) = project {
            project.verify(&self.profile)?;
        }
        Ok(())
    }
    pub fn verify_consumer(&self, profile: &Path) -> Result<()> {
        let receiver = self.receiver()?;
        let expected = PrivateDirectory::open_existing(profile)?;
        expected.verify_private_directory()?;
        ensure!(
            expected.directory_identity()? == receiver.store.identity,
            "source_transfer_wrong_consumer"
        );
        self.inventory()?;
        Ok(())
    }
}
