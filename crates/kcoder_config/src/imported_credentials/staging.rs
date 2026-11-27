//! Staged file keys remain exclusively in the legitimate private credential document.
use super::*;

impl ImportedCredentialStore {
    /// Prepare an operation-owned key without publishing a Provider credential binding.
    pub fn stage(
        &self,
        reference: &CredentialImportRef,
        key: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<ImportState> {
        self.check(reference)?;
        validate_secret(reference, key)?;
        let _lock = self.lock("credentials.json.lock", true)?;
        self.require_no_pending_pair()?;
        match self.directory.entry_metadata(OsStr::new(GROUP_JOURNAL)) {
            Ok(_) => anyhow::bail!("credential_group_recovery_required"),
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        let mut store = self.read()?;
        let fingerprint = hash(key);
        self.validate_mcp_extension(&store.0, reference, key, backend)?;
        if let Some(receipt) = store
            .0
            .imported_credentials
            .receipts
            .get(&reference.operation_id)
        {
            ensure!(
                receipt.reference == *reference && receipt.fingerprint == fingerprint,
                "credential_import_receipt_conflict"
            );
            ensure!(
                receipt.state == ImportState::Staged,
                "credential_import_not_staged"
            );
        } else {
            mcp::extensions::require_available(&store.0, reference)?;
            ensure!(
                store.0.imported_credentials.receipts.len() < 4096,
                "credential_import_budget_exceeded"
            );
            if reference.storage == ImportStorage::Keyring {
                ensure!(backend.available(), "credential_import_keyring_unavailable");
                ensure!(
                    backend
                        .get(&reference.account)
                        .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                        .is_none(),
                    "credential_import_account_exists"
                );
            }
            store.0.imported_credentials.receipts.insert(
                reference.operation_id.clone(),
                ImportedCredentialReceipt {
                    reference: reference.clone(),
                    fingerprint: fingerprint.clone(),
                    state: ImportState::Staged,
                    staged_key: (reference.storage == ImportStorage::File)
                        .then(|| StagedKey(key.into())),
                },
            );
            self.save(&store.0)?;
        }
        ensure!(
            !mcp::occupied(&store.0, reference),
            "credential_import_target_exists"
        );
        match reference.storage {
            ImportStorage::File => {
                let receipt = store
                    .0
                    .imported_credentials
                    .receipts
                    .get_mut(&reference.operation_id)
                    .unwrap();
                if receipt.staged_key.is_none() {
                    receipt.staged_key = Some(StagedKey(key.into()));
                    self.save(&store.0)?;
                }
            }
            ImportStorage::Keyring => {
                ensure!(backend.available(), "credential_import_keyring_unavailable");
                match backend
                    .get(&reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                {
                    Some(value) => {
                        let value = Zeroizing::new(value);
                        ensure!(
                            hash(&value) == fingerprint,
                            "credential_import_account_changed"
                        );
                    }
                    None => backend
                        .set(&reference.account, key)
                        .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?,
                }
            }
        }
        Ok(ImportState::Staged)
    }
}
