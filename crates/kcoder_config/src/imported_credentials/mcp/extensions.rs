//! Explicit predecessor chains preserve prior MCP fields and prevent premature removal.
use super::*;
use std::collections::BTreeSet;

fn ancestors(store: &CredentialStore, reference: &CredentialImportRef) -> Result<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    let mut child = reference;
    while let Some(id) = &child.predecessor {
        ensure!(
            ids.len() < 32 && ids.insert(id.clone()),
            "mcp_credential_predecessor_cycle"
        );
        let previous = store
            .imported_credentials
            .receipts
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_predecessor_missing"))?;
        ensure!(
            previous.state == ImportState::Published
                && previous.reference.same_owner(reference)
                && previous.reference.profile_identity == reference.profile_identity,
            "mcp_credential_predecessor_changed"
        );
        let (
            CredentialSubject::Mcp {
                binding,
                env,
                headers,
            },
            CredentialSubject::Mcp {
                binding: old_binding,
                env: old_env,
                headers: old_headers,
            },
        ) = (&child.subject, &previous.reference.subject)
        else {
            anyhow::bail!("mcp_credential_wrong_subject")
        };
        ensure!(
            binding == old_binding
                && old_env.iter().all(|name| env.contains(name))
                && old_headers.iter().all(|name| headers.contains(name))
                && env.len() + headers.len() > old_env.len() + old_headers.len(),
            "mcp_credential_extension_fields_invalid"
        );
        child = &previous.reference;
    }
    Ok(ids)
}

pub(in crate::imported_credentials) fn require_available(
    store: &CredentialStore,
    reference: &CredentialImportRef,
) -> Result<()> {
    let previous = ancestors(store, reference)?;
    ensure!(
        !reference.subject.is_provider()
            || (!store.credentials.contains_key(&reference.provider)
                && !store.revoked.contains(&reference.provider)),
        "credential_import_target_exists"
    );
    ensure!(
        !store.imported_credentials.receipts.values().any(|receipt| {
            receipt.reference.same_owner(reference)
                && receipt.state != ImportState::Undone
                && receipt.reference.operation_id != reference.operation_id
                && !previous.contains(&receipt.reference.operation_id)
        }),
        "credential_import_target_exists"
    );
    Ok(())
}

pub(in crate::imported_credentials) fn require_unreferenced(
    store: &CredentialStore,
    reference: &CredentialImportRef,
) -> Result<()> {
    ensure!(
        !store.imported_credentials.receipts.values().any(|receipt| {
            receipt.reference.predecessor.as_deref() == Some(reference.operation_id.as_str())
                && receipt.state != ImportState::Undone
        }),
        "mcp_credential_has_dependents"
    );
    Ok(())
}

impl ImportedCredentialStore {
    pub(in crate::imported_credentials) fn verify_mcp_predecessors(
        &self,
        store: &CredentialStore,
        reference: &CredentialImportRef,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        for id in ancestors(store, reference)? {
            let previous = &store.imported_credentials.receipts[&id];
            self.check_binding(store, &previous.reference, &previous.fingerprint, backend)?;
        }
        Ok(())
    }

    pub(in crate::imported_credentials) fn validate_mcp_extension(
        &self,
        store: &CredentialStore,
        reference: &CredentialImportRef,
        key: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        let Some(id) = &reference.predecessor else {
            return Ok(());
        };
        require_available(store, reference)?;
        let previous = store
            .imported_credentials
            .receipts
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_predecessor_missing"))?;
        self.check_binding(store, &previous.reference, &previous.fingerprint, backend)?;
        let old = match previous.reference.storage {
            ImportStorage::File => Zeroizing::new(
                binding(store, &previous.reference)
                    .ok_or_else(|| anyhow::anyhow!("mcp_credential_predecessor_missing"))?
                    .to_owned(),
            ),
            ImportStorage::Keyring => Zeroizing::new(
                backend
                    .get(&previous.reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                    .ok_or_else(|| anyhow::anyhow!("mcp_credential_predecessor_missing"))?,
            ),
        };
        let old = McpSecretValues::decode(&old)?;
        let next = McpSecretValues::decode(key)?;
        ensure!(
            old.env
                .iter()
                .all(|(name, value)| next.env.get(name) == Some(value))
                && old
                    .headers
                    .iter()
                    .all(|(name, value)| next.headers.iter().any(
                        |(next_name, next_value)| next_name.eq_ignore_ascii_case(name)
                            && next_value == value
                    )),
            "mcp_credential_preserved_value_changed"
        );
        Ok(())
    }
}
