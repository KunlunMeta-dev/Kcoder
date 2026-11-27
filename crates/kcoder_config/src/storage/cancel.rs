//! Cancellation of an operation that has not entered the copy boundary.
//! A partial publication remains Active until its original owner reconciles it.
use super::*;

#[path = "cancel_cleanup.rs"]
mod cleanup;

impl StorageCoordinator {
    /// Cancelling a stop request does not terminate independent writers. No
    /// source or target payload is deleted, recreated, or adopted by this path.
    pub fn cancel_before_copy(&mut self, id: &str) -> Result<StorageMigrationReceipt> {
        let receipt = self.require(id)?;
        if receipt.disposition == Disposition::Deferred
            && receipt.error_code.as_deref() == Some("STORAGE_OPERATION_CANCELLED")
        {
            ensure!(
                location(&self.directory)? == receipt.plan.original,
                "STORAGE_SELECTION_CHANGED"
            );
            return Ok(receipt);
        }
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(receipt.phase, Phase::Planned | Phase::Stopping),
            "STORAGE_CANCEL_RECONCILIATION_REQUIRED"
        );
        ensure!(
            location(&self.directory)? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        if !receipt.owner_receipts.is_empty() {
            // Stopping may have recorded an in-place control descriptor before
            // its preparation name appeared. Reacquire actual writer fences;
            // defer_after_cleanup still authenticates every existing leaf.
            ensure!(
                receipt.phase == Phase::Stopping
                    && receipt.owner_receipts.keys().all(|key| {
                        receipt.plan.components.iter().any(|component| {
                            component.source == component.destination
                                && component.source == receipt.plan.from.data_root
                                && key == &format!("pending-{}", component.domain)
                        })
                    }),
                "STORAGE_CANCEL_RECONCILIATION_REQUIRED"
            );
            self.require_stopped(&receipt.plan)?;
        }
        for component in &receipt.plan.components {
            ensure!(
                PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                    == component.source_identity,
                "STORAGE_SOURCE_CHANGED"
            );
        }
        self.defer_after_cleanup(id, "STORAGE_OPERATION_CANCELLED")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{StorageInstance, StorageResolveInput, storage_location_file};
    use kcoder_types::{StorageLaunchIntent, StorageMigrationComponent};
    use std::fs;

    #[test]
    fn pending_marker_crashes_before_fixed_publication_resume_or_cancel_the_original_id() {
        const ROOT: &str = "KCODER_STORAGE_PENDING_CRASH_ROOT";
        const CHECKPOINT: &str = "KCODER_STORAGE_PENDING_CRASH_CHECKPOINT";
        const ID: &str = "pending-marker-crash";
        if let Some(home) = std::env::var_os(ROOT) {
            let home = PathBuf::from(home);
            let from = crate::storage::resolve_storage_paths(&StorageResolveInput {
                home: Some(home.clone()),
                ..Default::default()
            })
            .unwrap();
            fs::create_dir_all(&from.data_root).unwrap();
            fs::write(from.data_root.join("business"), b"original state").unwrap();
            let root = PrivateDirectory::open_existing(&from.data_root).unwrap();
            let plan = StorageMigrationPlan {
                version: 1,
                operation_id: ID.into(),
                original: None,
                components: vec![StorageMigrationComponent {
                    domain: "persistent-root".into(),
                    source: from.data_root.clone(),
                    destination: from.data_root.clone(),
                    source_identity: root.directory_identity().unwrap(),
                    estimated_bytes: 0,
                }],
                target: StorageLocationRecord {
                    version: 1,
                    revision: 1,
                    data_root: from.data_root.clone(),
                    cache_root: home.join("new-cache"),
                    operation_id: Some(ID.into()),
                },
                from,
                target_bindings: vec![],
                launch_intent: StorageLaunchIntent::VerifyOnly,
            };
            let mut coordinator = StorageCoordinator::acquire(&home).unwrap();
            coordinator.begin(plan).unwrap();
            let mut receipt = coordinator
                .advance(ID, Phase::Planned, Phase::Stopping)
                .unwrap();
            coordinator.require_stopped(&receipt.plan).unwrap();
            let save_receipt = std::env::var(CHECKPOINT).unwrap() == "after";
            crate::storage::component_publication::prepare_pending_in_place(
                &mut receipt,
                &coordinator.directory,
                &coordinator.path,
                &coordinator.roots,
                |updated| {
                    if save_receipt {
                        coordinator.write_receipt(updated)?;
                    }
                    // Keep the real random temp by exiting without destructors.
                    std::process::exit(73);
                },
            )
            .unwrap();
            panic!("owned crash checkpoint was not reached");
        }
        for checkpoint in ["before", "after"] {
            let owned = tempfile::tempdir().unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "storage::control::cancel::tests::pending_marker_crashes_before_fixed_publication_resume_or_cancel_the_original_id", "--test-threads=1"])
                .env_clear()
                .env(ROOT, owned.path())
                .env(CHECKPOINT, checkpoint);
            if let Some(system_root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", system_root);
            }
            let output = command.output().unwrap();
            assert_eq!(output.status.code(), Some(73), "{output:?}");
            let mut recovered = StorageCoordinator::acquire(owned.path()).unwrap();
            let receipt = recovered.current().unwrap().unwrap();
            assert_eq!(receipt.plan.operation_id, ID);
            assert_eq!(receipt.phase, Phase::Stopping);
            assert_eq!(receipt.disposition, Disposition::Active);
            assert_eq!(
                receipt
                    .owner_receipts
                    .contains_key("pending-persistent-root"),
                checkpoint == "after"
            );
            let source = &receipt.plan.from.data_root;
            assert!(!source.join("kcoder-storage-pending.json").exists());
            assert!(
                !source
                    .join(format!(".kcoder-pending-{ID}-persistent-root"))
                    .exists()
            );
            let root = PrivateDirectory::open_existing(source).unwrap();
            let temporary = root
                .entry_names_bounded(16)
                .unwrap()
                .into_iter()
                .find(|name| name.to_string_lossy().starts_with(".kcoder."))
                .unwrap();
            let orphan = fs::read(source.join(&temporary)).unwrap();
            let identity = crate::PortableLeaseIdentity::from_private_regular_handle(
                &root.open_single_link_regular_file(&temporary).unwrap(),
            )
            .unwrap();
            if checkpoint == "before" {
                recovered
                    .advance(ID, Phase::Stopping, Phase::Stopped)
                    .unwrap();
            }
            let cancelled = recovered.cancel_operation(ID).unwrap();
            assert_eq!(cancelled.disposition, Disposition::Deferred);
            assert_eq!(cancelled.plan, receipt.plan);
            assert!(cancelled.owner_receipts.is_empty());
            assert_eq!(
                fs::read(source.join("business")).unwrap(),
                b"original state"
            );
            assert_eq!(fs::read(source.join(&temporary)).unwrap(), orphan);
            assert_eq!(
                crate::PortableLeaseIdentity::from_private_regular_handle(
                    &root.open_single_link_regular_file(&temporary).unwrap(),
                )
                .unwrap(),
                identity
            );
            drop(recovered);
            drop(
                StorageInstance::open(StorageResolveInput {
                    home: Some(owned.path().into()),
                    ..Default::default()
                })
                .unwrap(),
            );
            let mut retry = StorageCoordinator::acquire(owned.path()).unwrap();
            retry.retry_deferred(ID).unwrap();
            retry.advance(ID, Phase::Planned, Phase::Stopping).unwrap();
            retry.advance(ID, Phase::Stopping, Phase::Stopped).unwrap();
            let inventory = retry
                .inventory_source(ID, "persistent-root", &std::collections::BTreeSet::new())
                .unwrap();
            assert!(
                inventory
                    .entries
                    .iter()
                    .any(|entry| entry.relative_path == Path::new(&temporary)
                        && !entry.excluded
                        && entry.sha256.is_some())
            );
            assert_eq!(fs::read(source.join(&temporary)).unwrap(), orphan);
            retry.cancel_operation(ID).unwrap();
            let unknown = if checkpoint == "before" {
                format!(".kcoder-pending-{ID}-persistent-root")
            } else {
                "kcoder-storage-pending.json".into()
            };
            root.atomic_replace(OsStr::new(&unknown), &orphan).unwrap();
            retry.retry_deferred(ID).unwrap();
            retry.advance(ID, Phase::Planned, Phase::Stopping).unwrap();
            assert!(retry.advance(ID, Phase::Stopping, Phase::Stopped).is_err());
            assert!(retry.cancel_operation(ID).is_err());
            assert_eq!(fs::read(source.join(&unknown)).unwrap(), orphan);
            assert_eq!(
                retry.current().unwrap().unwrap().disposition,
                Disposition::Active
            );
        }
    }

    #[test]
    fn cancelling_stop_keeps_live_writers_and_source_then_reconciles_the_same_id() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path();
        let source = home.join("original");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("settings.json"), b"original bytes").unwrap();
        let original = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: source.clone(),
            cache_root: home.join("cache"),
            operation_id: None,
        };
        fs::create_dir(home.join(".config")).unwrap();
        fs::write(
            storage_location_file(home),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        let running = StorageInstance::open(StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        let from = running.paths().clone();
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: "cancel-owned-stop".into(),
            original: Some(original),
            from,
            components: vec![StorageMigrationComponent {
                domain: "persistent-root".into(),
                source: source.clone(),
                destination: home.join("target"),
                source_identity: PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            target: StorageLocationRecord {
                version: 1,
                revision: 2,
                data_root: home.join("target"),
                cache_root: home.join("next-cache"),
                operation_id: Some("cancel-owned-stop".into()),
            },
            target_bindings: vec![],
            launch_intent: StorageLaunchIntent::Desktop,
        };
        coordinator.begin(plan).unwrap();
        coordinator
            .advance("cancel-owned-stop", Phase::Planned, Phase::Stopping)
            .unwrap();
        assert!(
            coordinator
                .advance("cancel-owned-stop", Phase::Stopping, Phase::Stopped)
                .is_err()
        );
        let cancelled = coordinator.cancel_before_copy("cancel-owned-stop").unwrap();
        assert_eq!(cancelled.disposition, Disposition::Deferred);
        assert_eq!(
            coordinator.cancel_before_copy("cancel-owned-stop").unwrap(),
            cancelled
        );
        assert!(coordinator.cancel_before_copy("other-operation").is_err());
        assert!(!home.join("target").exists());
        assert_eq!(
            fs::read(source.join("settings.json")).unwrap(),
            b"original bytes"
        );
        drop(coordinator);
        let peer = StorageInstance::open(StorageResolveInput {
            home: Some(home.into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(peer.paths().data_root, running.paths().data_root);
        drop(peer);
        drop(running);
        let mut coordinator = StorageCoordinator::acquire(home).unwrap();
        coordinator.retry_deferred("cancel-owned-stop").unwrap();
        for (from, to) in [
            (Phase::Planned, Phase::Stopping),
            (Phase::Stopping, Phase::Stopped),
            (Phase::Stopped, Phase::Copying),
        ] {
            coordinator.advance("cancel-owned-stop", from, to).unwrap();
        }
        let before = coordinator.current().unwrap().unwrap();
        assert!(
            coordinator
                .cancel_before_copy("cancel-owned-stop")
                .unwrap_err()
                .to_string()
                .contains("STORAGE_CANCEL_RECONCILIATION_REQUIRED")
        );
        assert_eq!(coordinator.current().unwrap().unwrap(), before);
    }
}
