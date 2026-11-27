//! Active references that keep settled operation receipts live.
//!
//! This crate sits below the runtime driver, so it reads runtime bindings at
//! the on-disk format level (`runtime-bindings/binding-*.json`, fields
//! `operationId` and `cancelOperation`) instead of depending on the driver.
//! The runtime driver's typed snapshot (`active_operation_references` in
//! `internal/runtime_driver/binding_retention.rs`) applies the same rule; keep
//! the two in step. Any unreadable binding or ledger fails the snapshot, so no
//! receipt is retired without complete reference knowledge.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_integration_storage::integrations::core::{
    IntegrationOperationStore,
    budgets::NativeBudgetStore,
    operation_store::{IntegrationOperationRetirement, MAX_INTEGRATION_OPERATION_RECORDS},
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::IntegrationNullable;
use std::{collections::BTreeSet, ffi::OsStr, io::Read};

/// Receipt sweeps start once the shared ledger is three quarters full.
pub const OPERATION_RECEIPT_SWEEP_THRESHOLD: usize =
    MAX_INTEGRATION_OPERATION_RECORDS - MAX_INTEGRATION_OPERATION_RECORDS / 4;
const MAX_BINDING_BYTES: u64 = 768 * 1024;
const MAX_BINDINGS: usize = 4096;

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// Live runtime bindings (operation and cancellation) in the Operations
/// domain directory. Retired bindings (`retired-*`) are settled history.
fn binding_references(operations: &PrivateDirectory, out: &mut BTreeSet<String>) -> Result<()> {
    let bindings = match operations.open_entry_handle(OsStr::new("runtime-bindings")) {
        Ok(entry) => entry.open_child_directory()?,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut count = 0;
    bindings.visit_regular_files(
        |name| name.to_string_lossy().starts_with("binding-"),
        |_, file| {
            count += 1;
            ensure!(count <= MAX_BINDINGS, "RUNTIME_BINDING_CAPACITY");
            let mut bytes = Vec::new();
            file.take(MAX_BINDING_BYTES + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 <= MAX_BINDING_BYTES,
                "RUNTIME_BINDING_TOO_LARGE"
            );
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).context("RUNTIME_BINDING_CORRUPT")?;
            let operation = value
                .get("operationId")
                .and_then(serde_json::Value::as_str)
                .context("RUNTIME_BINDING_CORRUPT")?;
            out.insert(operation.to_owned());
            if let Some(cancel) = value
                .get("cancelOperation")
                .and_then(serde_json::Value::as_str)
            {
                out.insert(cancel.to_owned());
            }
            Ok(())
        },
    )
}

/// Captured before the receipt writer lock: live runtime bindings and every
/// budget reservation whose execution is not confirmed terminal. Native
/// delegation journal operations are a separate namespace.
pub fn active_operation_references(
    context: &NativeIntegrationContext,
    operations: &PrivateDirectory,
) -> Result<BTreeSet<String>> {
    let mut references = BTreeSet::new();
    binding_references(operations, &mut references)?;
    if context.scope().organization_id.is_none() {
        let mut account = context.scope().clone();
        account.workspace_id = IntegrationNullable::Null;
        let profile = context.profile()?;
        if let Some(guard) = NativeDomainGuard::observe(profile, &account, NativeDomain::Budgets)?
            && let Some(budgets) = NativeBudgetStore::open_in(
                &guard.directory(profile)?,
                OsStr::new("ledger"),
                &account,
            )?
        {
            references.extend(budgets.active_root_operations()?);
        }
    }
    Ok(references)
}

/// Sweep only a nearly full ledger. A busy writer skips this round; the
/// ledger's own capacity check still refuses before creating a receipt.
pub fn retire_receipts_if_needed(
    context: &NativeIntegrationContext,
    operations: &PrivateDirectory,
    ledger: &IntegrationOperationStore,
    now_ms: u64,
) -> Result<Option<IntegrationOperationRetirement>> {
    if ledger.live_count()? < OPERATION_RECEIPT_SWEEP_THRESHOLD {
        return Ok(None);
    }
    let references = active_operation_references(context, operations)?;
    ledger
        .retire_settled(now_ms, |receipt| references.contains(&receipt.operation_id))
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_bindings_reference_their_operation_and_cancellation_only() -> Result<()> {
        let root = tempfile::tempdir()?;
        let operations = PrivateDirectory::open_or_create(root.path())?;
        let mut references = BTreeSet::new();
        binding_references(&operations, &mut references)?;
        assert!(references.is_empty(), "no binding store means no reference");

        let bindings = operations.create_private_child(OsStr::new("runtime-bindings"))?;
        bindings.atomic_replace(
            OsStr::new("binding-a.json"),
            br#"{"operationId":"live","cancelOperation":"live-cancel"}"#,
        )?;
        bindings.atomic_replace(
            OsStr::new("retired-binding-b.json"),
            br#"{"operationId":"retired"}"#,
        )?;
        binding_references(&operations, &mut references)?;
        assert_eq!(
            references,
            BTreeSet::from(["live".to_owned(), "live-cancel".to_owned()])
        );

        // An unreadable live binding fails the snapshot instead of dropping it.
        bindings.atomic_replace(OsStr::new("binding-c.json"), b"{not json")?;
        assert!(binding_references(&operations, &mut BTreeSet::new()).is_err());
        Ok(())
    }
}
