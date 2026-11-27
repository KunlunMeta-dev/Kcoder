//! Group removal uses the same settings publication point; backend deletion is a later cleanup.
use super::*;

fn undo_name(id: &str) -> String {
    format!(".credential-{id}.undo.settings")
}
fn budget(store: &CredentialStore) -> Result<()> {
    store.imported_credentials.validate()?;
    let bytes = Zeroizing::new(serde_json::to_vec(store)?);
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "credential_import_budget_exceeded"
    );
    Ok(())
}

impl ImportedCredentialStore {
    /// Atomically deactivate the group's bindings and reverse its settings edit.
    /// The callback only edits the document; it must not acquire storage locks.
    pub fn undo_group(
        &self,
        group_id: &str,
        backend: &dyn CredentialBackend,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<CredentialGroupReceipt> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _settings = self.lock("settings.json.lock", true)?;
        let _credentials = self.lock("credentials.json.lock", true)?;
        let credential_version = self.optional_identity("credentials.json")?;
        let mut store = self.read()?;
        let mut group = store
            .0
            .imported_credentials
            .groups
            .get(group_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("credential_group_receipt_required"))?;
        for reference in &group.references {
            self.check(reference)?;
            mcp::extensions::require_unreferenced(&store.0, reference)?;
        }
        if group.outcome != CredentialGroupOutcome::Committed {
            return Ok(group);
        }
        let before_file = self.optional_identity("settings.json")?;
        let settings = ProfileSettingsFile::new(self.directory.try_clone()?)?;
        let (source, original) = settings.read_document()?;
        ensure!(
            before_file == self.optional_identity("settings.json")?
                && revision(&original)? == group.after_revision,
            "credential_group_settings_changed"
        );
        let mut next = original.clone();
        update(&mut next)?;
        crate::validate_and_resolve_settings_document(&next)?;
        ensure!(
            revision(&next)? == group.before_revision,
            "credential_group_undo_plan_mismatch"
        );
        for reference in &group.references {
            let receipt = store
                .0
                .imported_credentials
                .receipts
                .get(&reference.operation_id)
                .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
            ensure!(
                receipt.reference == *reference && receipt.state == ImportState::Published,
                "credential_import_target_changed"
            );
            self.check_binding(&store.0, reference, &receipt.fingerprint, backend)?;
            self.verify_mcp_predecessors(&store.0, reference, backend)?;
        }
        for reference in &group.references {
            let binding = mcp::remove_binding(&mut store.0, reference, true).unwrap();
            let receipt = store
                .0
                .imported_credentials
                .receipts
                .get_mut(&reference.operation_id)
                .unwrap();
            if reference.storage == ImportStorage::File {
                receipt.staged_key = Some(StagedKey(binding.to_string()));
            }
            receipt.state = ImportState::Undoing;
        }
        group.outcome = CredentialGroupOutcome::Undone;
        store
            .0
            .imported_credentials
            .groups
            .insert(group_id.into(), group.clone());
        budget(&store.0)?;
        store
            .0
            .imported_credentials
            .groups
            .get_mut(group_id)
            .unwrap()
            .outcome = CredentialGroupOutcome::Committed;
        ensure!(
            credential_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        let name = undo_name(group_id);
        let bytes = Zeroizing::new(render_settings_update(source.as_deref(), &original, &next)?);
        let mut prepared = self
            .directory
            .open_read_write_file(OsStr::new(&name), true)?;
        prepared.write_all(&bytes)?;
        prepared.sync_all()?;
        drop(prepared);
        let pending = Pending {
            version: 1,
            receipt: group.clone(),
            before_file,
            after_file: self.directory.regular_file_identity(OsStr::new(&name))?,
            undo: true,
        };
        self.directory
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&pending)?)?;
        fail(4)?;
        ensure!(
            credential_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        self.save(&store.0)?;
        let deactivated_version = self.optional_identity("credentials.json")?;
        fail(5)?;
        ensure!(
            pending.before_file == self.optional_identity("settings.json")?,
            "credential_group_settings_changed"
        );
        self.directory.publish_prepared(
            OsStr::new(&name),
            OsStr::new("settings.json"),
            &pending.after_file,
        )?;
        fail(6)?;
        ensure!(
            deactivated_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        store
            .0
            .imported_credentials
            .groups
            .insert(group_id.into(), group.clone());
        self.save(&store.0)?;
        self.directory.remove_regular_file(OsStr::new(JOURNAL))?;
        Ok(group)
    }

    pub(super) fn recover_undo_locked(
        &self,
        pending: Pending,
        mut store: PrivateCredentials,
    ) -> Result<()> {
        let current_id = self.optional_identity("settings.json")?;
        let current_revision = revision(&self.settings()?)?;
        let committed = current_id.as_deref() == Some(&pending.after_file)
            && current_revision == pending.receipt.before_revision;
        let aborted =
            current_id == pending.before_file && current_revision == pending.receipt.after_revision;
        ensure!(committed || aborted, "credential_group_settings_conflict");
        for reference in &pending.receipt.references {
            let receipt = store
                .0
                .imported_credentials
                .receipts
                .get(&reference.operation_id)
                .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
            ensure!(
                receipt.reference == *reference,
                "credential_import_receipt_conflict"
            );
            match receipt.state {
                ImportState::Published if aborted => {
                    self.check_binding_metadata(&store.0, reference, &receipt.fingerprint)?
                }
                ImportState::Undoing => ensure!(
                    mcp::binding(&store.0, reference).is_none()
                        && mcp::revoked(&store.0, reference),
                    "credential_import_target_changed"
                ),
                _ => anyhow::bail!("credential_import_target_changed"),
            }
        }
        if aborted {
            for reference in &pending.receipt.references {
                let receipt = store
                    .0
                    .imported_credentials
                    .receipts
                    .get_mut(&reference.operation_id)
                    .unwrap();
                if receipt.state == ImportState::Undoing {
                    let binding = match reference.storage {
                        ImportStorage::File => receipt
                            .staged_key
                            .take()
                            .ok_or_else(|| anyhow::anyhow!("credential_import_staged_key_missing"))?
                            .0
                            .clone(),
                        ImportStorage::Keyring => marker_for_provider(&reference.account),
                    };
                    receipt.state = ImportState::Published;
                    mcp::set_binding(&mut store.0, reference, binding)?;
                }
            }
        }
        let mut group = pending.receipt;
        group.outcome = if committed {
            CredentialGroupOutcome::Undone
        } else {
            CredentialGroupOutcome::Committed
        };
        store
            .0
            .imported_credentials
            .groups
            .insert(group.group_id.clone(), group.clone());
        self.save(&store.0)?;
        let name = undo_name(&group.group_id);
        if self.optional_identity(&name)?.as_deref() == Some(&pending.after_file) {
            self.directory.remove_regular_file(OsStr::new(&name))?;
        }
        self.directory.remove_regular_file(OsStr::new(JOURNAL))
    }
}
