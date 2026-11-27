//! Compose the original Native relocation capability with the offline Node owner.
//! Neither a copied binding nor the helper's reply grants Native authority.
use super::storage_owner_child::run_offline_owner_child;
use anyhow::{Context, Result, ensure};
use kcoder_config::storage::{StorageCoordinator, node_storage_path};
use kcoder_native_service_runtime::connectivity::lease::relocation::{
    NativeConnectivityRelocation, NativeConnectivityRelocationReceipt,
    NativeConnectivityRelocationSource,
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

#[cfg(all(test, unix))]
#[path = "storage_connectivity_tests.rs"]
mod tests;

fn declared_store_target(
    coordinator: &StorageCoordinator,
    namespace: &str,
    source: &Path,
    actual_target: Option<&Path>,
) -> Result<PathBuf> {
    let plan = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?
        .plan;
    let leaf = kcoder_connectivity_storage::control::DATA;
    let expected_source = plan.from.data_root.join(namespace).join(leaf);
    let expected_target = plan.target.data_root.join(namespace).join(leaf);
    let identity = |path: &Path| {
        kcoder_config::PrivateDirectory::open_existing(path)
            .and_then(|directory| directory.directory_identity())
            .context("STORAGE_OFFLINE_DOMAIN_MISMATCH")
    };
    ensure!(
        identity(source)? == identity(&expected_source)?,
        "STORAGE_OFFLINE_DOMAIN_MISMATCH"
    );
    if let Some(actual) = actual_target {
        ensure!(
            identity(actual)? == identity(&expected_target)?,
            "STORAGE_OFFLINE_DOMAIN_MISMATCH"
        );
    }
    Ok(expected_target)
}

/// Check the original source before inventory under its real Native kernel
/// lease. The coordinator retains full-instance exclusion across copying;
/// callers may also retain this source owner until target preparation.
pub(super) async fn verify_connectivity_source(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: &mut Command,
    source_owner: &NativeConnectivityRelocationSource<'_>,
) -> Result<()> {
    ensure!(
        source_owner.operation_id() == id,
        "STORAGE_OPERATION_CONFLICT"
    );
    let fences = coordinator.prepare_offline_child_fences(id)?;
    let source = source_owner.source_data_path()?;
    let target = declared_store_target(coordinator, source_owner.namespace_id(), &source, None)?;
    let source = node_storage_path(&source)?;
    let target = node_storage_path(&target)?;
    let facts = json!({"domain":"native-application-store", "operationId":id,
        "source":source, "finalTarget":target});
    let mut source_facts = facts.clone();
    source_facts["purpose"] = json!("nativeStoreSource");
    source_facts["namespaceId"] = json!(source_owner.namespace_id());
    source_facts["initializationId"] = json!(source_owner.initialization_id());
    let result = run_offline_owner_child(
        coordinator,
        id,
        command,
        json!({"version":1,"phase":"prepareSource","domains":[{
            "kind":"sealed", "source":source, "finalTarget":target,
            "namespaceId":source_owner.namespace_id(),
            "initializationId":source_owner.initialization_id()}]}),
        Duration::from_secs(120),
        |requested| {
            if requested["purpose"] == "nativeStorePrivatePath" {
                let path = requested["path"]
                    .as_str()
                    .context("STORAGE_OFFLINE_DOMAIN_MISMATCH")?;
                let mut expected = source_facts.clone();
                expected["purpose"] = json!("nativeStorePrivatePath");
                expected["path"] = json!(path);
                ensure!(*requested == expected, "STORAGE_OFFLINE_DOMAIN_MISMATCH");
                return source_owner.verify_private_path(Path::new(path));
            }
            ensure!(
                *requested == facts || *requested == source_facts,
                "STORAGE_OFFLINE_DOMAIN_MISMATCH"
            );
            source_owner.verify()
        },
    )
    .await?;
    ensure!(
        result["version"] == 1 && result["operationId"] == id && result["phase"] == "prepareSource",
        "STORAGE_OFFLINE_CHILD_RESULT_INVALID"
    );
    let domains = result["domains"]
        .as_array()
        .filter(|values| values.len() == 1)
        .context("STORAGE_OFFLINE_CHILD_RESULT_INVALID")?;
    ensure!(
        domains[0]["kind"] == "sealed"
            && domains[0]["state"] == "prepared"
            && domains[0]["source"] == json!(source)
            && domains[0]["finalTarget"] == json!(target)
            && domains[0]["value"]["namespaceId"] == source_owner.namespace_id()
            && domains[0]["value"]["initializationId"] == source_owner.initialization_id(),
        "STORAGE_OFFLINE_CHILD_RESULT_INVALID"
    );
    source_owner.verify()?;
    coordinator.validate_offline_child_fences(id, &fences)
}

pub(super) async fn relocate_connectivity_store(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: &mut Command,
    transaction: NativeConnectivityRelocation<'_>,
) -> Result<NativeConnectivityRelocationReceipt> {
    ensure!(
        transaction.operation_id()? == id,
        "STORAGE_OPERATION_CONFLICT"
    );
    let fences = coordinator.prepare_offline_child_fences(id)?;
    let source = transaction.source_data_path()?;
    let target = transaction.target_data_path()?;
    declared_store_target(
        coordinator,
        transaction.namespace_id(),
        &source,
        Some(&target),
    )?;
    let source = node_storage_path(&source)?;
    let target = node_storage_path(&target)?;
    if let Some(completed) = transaction.query()? {
        coordinator.validate_offline_child_fences(id, &fences)?;
        return Ok(completed);
    }
    let facts = json!({"domain":"native-application-store", "operationId":id,
        "source":source, "finalTarget":target});
    let mut lease_facts = facts.clone();
    lease_facts["purpose"] = json!("nativeStoreLease");
    lease_facts["namespaceId"] = json!(transaction.namespace_id());
    lease_facts["initializationId"] = json!(transaction.initialization_id());
    let entry = json!({"kind":"sealed", "source":source, "finalTarget":target,
        "namespaceId":transaction.namespace_id(), "initializationId":transaction.initialization_id()});
    let result = run_offline_owner_child(
        coordinator,
        id,
        command,
        json!({"version":1, "phase":"relocate", "domains":[entry]}),
        Duration::from_secs(120),
        |requested| {
            if requested["purpose"] == "nativeStorePrivatePath" {
                let path = requested["path"]
                    .as_str()
                    .context("STORAGE_OFFLINE_DOMAIN_MISMATCH")?;
                let mut expected = lease_facts.clone();
                expected["purpose"] = json!("nativeStorePrivatePath");
                expected["path"] = json!(path);
                ensure!(*requested == expected, "STORAGE_OFFLINE_DOMAIN_MISMATCH");
                return transaction.verify_private_path(Path::new(path));
            }
            ensure!(
                *requested == facts || *requested == lease_facts,
                "STORAGE_OFFLINE_DOMAIN_MISMATCH"
            );
            // This is the original object holding both actual exclusive Native
            // leases. A successful global stop check alone is insufficient.
            transaction.verify()
        },
    )
    .await?;
    ensure!(
        result["version"] == 1 && result["operationId"] == id && result["phase"] == "relocate",
        "STORAGE_OFFLINE_CHILD_RESULT_INVALID"
    );
    let domains = result["domains"]
        .as_array()
        .filter(|values| values.len() == 1)
        .context("STORAGE_OFFLINE_CHILD_RESULT_INVALID")?;
    let item = &domains[0];
    ensure!(
        item["kind"] == "sealed"
            && item["state"] == "prepared"
            && item["source"] == json!(source)
            && item["finalTarget"] == json!(target),
        "STORAGE_OFFLINE_CHILD_RESULT_INVALID"
    );
    let value = &item["value"];
    ensure!(
        value["operationId"] == id
            && value["namespaceId"] == transaction.namespace_id()
            && value["initializationId"] == transaction.initialization_id()
            && value["sourceBindingHash"] == transaction.source_binding_hash()?,
        "STORAGE_OFFLINE_CHILD_RESULT_INVALID"
    );
    let hash = value["bindingHash"]
        .as_str()
        .context("STORAGE_OFFLINE_CHILD_RESULT_INVALID")?;
    coordinator.validate_offline_child_fences(id, &fences)?;
    // run_offline_owner_child has already observed EOF and the actual child's
    // successful exit. Commit then independently inspects the final private files.
    transaction.commit(hash)
}
