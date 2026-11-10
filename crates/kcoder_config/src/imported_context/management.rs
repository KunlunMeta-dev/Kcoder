//! Memory controls retain the original migration owner and atomically reconcile lost replies.
use super::*;
use sha2::{Digest, Sha256};
#[cfg(test)]
mod tests;

pub use kcoder_types::imported_memory::{ImportedMemoryControl, ImportedMemoryControlReceipt};

pub fn imported_context_revision(record: &ImportedContext) -> Result<String> {
    validate(record)?;
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(record)?)))
}

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(super) fn validate_receipt(id: &str, receipt: &ImportedMemoryControlReceipt) -> Result<()> {
    let request = &receipt.request;
    ensure!(
        id == request.request_id
            && atom(id)
            && atom(&request.id)
            && request.id.starts_with("ctx-")
            && atom(&request.owner_operation_id)
            && digest(&request.expected_revision)
            && digest(&receipt.applied_revision)
            && (!request.enabled || request.confirm_unverified_notes),
        "imported_context_invalid"
    );
    Ok(())
}

impl ImportedContextStore {
    /// A project mapping is separately authorized; a path spelling alone cannot rebind it.
    pub fn capture_memory_workspace(&self, scope: &ImportedContextScope) -> Result<Option<String>> {
        let ImportedContextScope::Project { root } = scope else {
            return Ok(None);
        };
        let directory = PrivateDirectory::open_existing(root)
            .map_err(|_| anyhow::anyhow!("imported_memory_workspace_unavailable"))?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            root.canonicalize().ok().as_ref() == Some(root),
            "imported_memory_scope_changed"
        );
        ensure!(
            crate::FolderTrustStore::trust_all_from_environment()
                || crate::FolderTrustStore::load(&self.profile).check(root)
                    == crate::FolderTrust::Trusted,
            "imported_memory_workspace_untrusted"
        );
        Ok(Some(directory.directory_identity()?))
    }

    pub fn verify_memory_scope(&self, record: &ImportedContext) -> Result<()> {
        if record.kind != ImportedContextKind::Memory {
            return Ok(());
        }
        let current = self.capture_memory_workspace(&record.scope)?;
        ensure!(
            current == record.memory_workspace_identity,
            "imported_memory_scope_changed"
        );
        Ok(())
    }

    pub fn memory_control(
        &self,
        request: &ImportedMemoryControl,
    ) -> Result<ImportedMemoryControlReceipt> {
        ensure!(
            atom(&request.request_id)
                && atom(&request.id)
                && request.id.starts_with("ctx-")
                && atom(&request.owner_operation_id)
                && digest(&request.expected_revision),
            "imported_context_invalid"
        );
        ensure!(
            !request.enabled || request.confirm_unverified_notes,
            "imported_memory_review_required"
        );
        self.update(|state| {
            if let Some(receipt) = state.memory_controls.get(&request.request_id) {
                ensure!(
                    &receipt.request == request,
                    "imported_context_request_changed"
                );
                return Ok(receipt.clone());
            }
            ensure!(
                state.memory_controls.len() < 4096,
                "imported_context_budget_exceeded"
            );
            let record = state
                .records
                .get_mut(&request.id)
                .ok_or_else(|| anyhow::anyhow!("imported_context_unavailable"))?;
            ensure!(
                record.kind == ImportedContextKind::Memory
                    && record.operation_id == request.owner_operation_id,
                "imported_context_conflict"
            );
            ensure!(
                imported_context_revision(record)? == request.expected_revision,
                "imported_context_revision_conflict"
            );
            if request.enabled {
                self.verify_memory_scope(record)?;
            }
            record.enabled = request.enabled;
            let receipt = ImportedMemoryControlReceipt {
                request: request.clone(),
                applied_revision: imported_context_revision(record)?,
            };
            state
                .memory_controls
                .insert(request.request_id.clone(), receipt.clone());
            Ok(receipt)
        })
    }

    pub fn memory_control_receipt(
        &self,
        request_id: &str,
    ) -> Result<Option<ImportedMemoryControlReceipt>> {
        ensure!(atom(request_id), "imported_context_invalid");
        let _lock = self
            .directory
            .try_shared_lock(OsStr::new(".imported-context.lock"))?
            .ok_or_else(|| anyhow::anyhow!("imported_context_busy"))?;
        Ok(self.read()?.memory_controls.get(request_id).cloned())
    }
}
