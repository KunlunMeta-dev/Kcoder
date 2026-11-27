//! Remove only an original publication's unchanged raw copy before selection commit.
use super::*;
use crate::storage::tree_copy::{
    CancellationCopy, inspect_cancellation_target, remove_cancellation_payload,
};

pub(in crate::storage) struct CancellationComponent {
    context: PublicationContext,
    directory: Option<PrivateDirectory>,
    path: PathBuf,
    name: OsString,
    container: Option<ContainerPublication>,
    actual: StorageTreeInventory,
    copy: Option<CancellationCopy>,
}

impl CancellationComponent {
    fn verify_scope(&self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        let (receipt, _, _) = coordinator.source_retirement_context(id)?;
        ensure!(
            crate::storage::read_storage_location_record(
                &coordinator
                    .source_retirement_control_path()?
                    .join("kcoder-storage.json")
            )? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        self.context.verify_attachment()?;
        if self.directory.is_some() {
            ensure!(
                PrivateDirectory::open_existing(&self.path)?.directory_identity()?
                    == self.actual.root_identity,
                "STORAGE_CANCEL_TARGET_CHANGED"
            );
        }
        Ok(())
    }

    pub(in crate::storage) fn held_directory_identities(&self) -> BTreeSet<String> {
        let mut identities = self
            .actual
            .entries
            .iter()
            .filter(|entry| entry.kind == crate::storage::StorageTreeEntryKind::Directory)
            .map(|entry| entry.identity.clone())
            .collect::<BTreeSet<_>>();
        if self.directory.is_some() {
            identities.insert(self.actual.root_identity.clone());
        }
        identities
    }

    pub(in crate::storage) fn remove(
        &self,
        coordinator: &mut StorageCoordinator,
        id: &str,
        before_remove: &mut impl FnMut(&Path) -> Result<()>,
    ) -> Result<()> {
        self.context.verify_attachment()?;
        if let Some(root) = &self.directory {
            ensure!(
                PrivateDirectory::open_existing(&self.path)?.directory_identity()?
                    == self.actual.root_identity,
                "STORAGE_CANCEL_TARGET_CHANGED"
            );
            remove_cancellation_payload(
                root,
                &self.actual,
                |relative| before_remove(&self.path.join(relative)),
                || self.verify_scope(coordinator, id),
            )?;
            // Root control leaves remain until all payload directories are gone.
            // A selected empty container retains its original fences and identity.
            for entry in self
                .actual
                .entries
                .iter()
                .filter(|entry| entry.excluded && entry.relative_path.components().count() == 1)
            {
                if self.container.as_ref().is_some_and(|container| {
                    container
                        .fences
                        .iter()
                        .any(|fence| fence.identity == entry.identity)
                }) {
                    continue;
                }
                coordinator.source_retirement_context(id)?;
                before_remove(&self.path.join(&entry.relative_path))?;
                self.verify_scope(coordinator, id)?;
                let name = entry.relative_path.as_os_str();
                let file = match root.open_single_link_regular_file(name) {
                    Ok(file) => file,
                    Err(error) if missing(&error) => continue,
                    Err(error) => return Err(error),
                };
                ensure!(
                    crate::storage::tree_copy::file_identity(&file)? == entry.identity,
                    "STORAGE_CANCEL_TARGET_CHANGED"
                );
                if name == OsStr::new(pending::LEAF) {
                    let original = pending::target_control(coordinator, id, root)?
                        .context("STORAGE_MIGRATION_PENDING")?;
                    ensure!(
                        pending::control_identity(&original)? == entry.identity,
                        "STORAGE_MIGRATION_PENDING"
                    );
                } else {
                    ensure!(file.metadata()?.len() == 0, "STORAGE_CANCEL_TARGET_CHANGED");
                }
                #[cfg(windows)]
                root.remove_regular_file_if_handle(name, &file)?;
                #[cfg(not(windows))]
                {
                    ensure!(
                        root.open_entry_handle(name)?.identity()? == entry.identity,
                        "STORAGE_CANCEL_TARGET_CHANGED"
                    );
                    root.remove_regular_file(name)?;
                }
            }
            self.context.verify_attachment()?;
            if let Some(container) = &self.container {
                let names = root.entry_names_bounded(container.fences.len() + 1)?;
                ensure!(
                    names.len() == container.fences.len(),
                    "STORAGE_CANCEL_TARGET_UNKNOWN"
                );
                for fence in &container.fences {
                    let entry = root.open_entry_handle(OsStr::new(&fence.name))?;
                    ensure!(
                        entry.identity()? == fence.identity && entry.metadata().len() == 0,
                        "STORAGE_COMPONENT_FENCE_CHANGED"
                    );
                }
            } else {
                ensure!(
                    root.entry_names_bounded(1)?.is_empty(),
                    "STORAGE_CANCEL_TARGET_UNKNOWN"
                );
                #[cfg(windows)]
                self.context
                    .parent
                    .remove_owned_empty_child(&self.name, root)?;
                #[cfg(not(windows))]
                {
                    ensure!(
                        self.context
                            .parent
                            .open_entry_handle(&self.name)?
                            .identity()?
                            == self.actual.root_identity,
                        "STORAGE_CANCEL_TARGET_CHANGED"
                    );
                    self.context.parent.remove_child_entry(&self.name, false)?;
                }
            }
        }
        if let Some(copy) = &self.copy {
            copy.remove_manifest(&self.context.operation_directory)?;
        }
        Ok(())
    }
}

pub(in crate::storage) fn prepare_cancellation_components(
    coordinator: &mut StorageCoordinator,
    receipt: &StorageMigrationReceipt,
) -> Result<Vec<CancellationComponent>> {
    let id = &receipt.plan.operation_id;
    let (_, _, operation) = coordinator.source_retirement_context(id)?;
    let mut prepared = Vec::new();
    for component in receipt
        .plan
        .components
        .iter()
        .filter(|component| component.source != component.destination)
    {
        let (component, source) = observe_declared_component(receipt, &component.domain)?;
        let context =
            observed_publication_context(operation.try_clone()?, receipt, component, source)?;
        let intent = read_intent(receipt, &owner_key(&context.component.domain)?)?;
        if intent.is_none() {
            ensure!(
                !receipt
                    .owner_receipts
                    .contains_key(&format!("copy-{}", context.component.domain))
                    && !receipt
                        .owner_receipts
                        .contains_key(&format!("pending-{}", context.component.domain)),
                "STORAGE_CANCEL_OWNER_RECONCILIATION_REQUIRED"
            );
        }
        if let Some(intent) = &intent {
            validate_record_metadata(receipt, id, &context, intent)?;
        }
        let staging = optional_directory(&context.parent, OsStr::new(&context.staging_name))?;
        let final_directory = optional_directory(&context.parent, &context.destination_name)?;
        let (directory, name, container) = match (&intent, staging, final_directory) {
            (None, None, None) => continue,
            (None, None, Some(root)) => {
                selected_container_binding(receipt, &context, &root)?;
                empty_container_fences(&root, &coordinator.held_writer_fence_identities(id)?)?;
                continue;
            }
            (Some(intent), None, None) if intent.container.is_none() => {
                (None, OsString::from(&intent.staging_name), None)
            }
            (Some(intent), Some(root), None)
                if intent.container.is_none()
                    && root.directory_identity()? == intent.staging_identity =>
            {
                (Some(root), OsString::from(&intent.staging_name), None)
            }
            (Some(intent), None, Some(root))
                if root.directory_identity()? == intent.staging_identity =>
            {
                (
                    Some(root),
                    context.destination_name.clone(),
                    intent.container.clone(),
                )
            }
            _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
        };
        let intent = intent.context("STORAGE_COMPONENT_RECEIPT_MISSING")?;
        let path = context.parent_path.join(&name);
        let mut controls = coordinator.held_writer_fence_identities(id)?;
        if let Some(root) = &directory {
            coordinator.fence_component_directory(&path, root)?;
            controls = coordinator.held_writer_fence_identities(id)?;
            if let Some(file) = pending::target_control(coordinator, id, root)? {
                controls.insert(pending::control_identity(&file)?);
            }
        }
        let key = format!("copy-{}", context.component.domain);
        let binding = receipt
            .owner_receipts
            .get(&key)
            .cloned()
            .map(serde_json::from_value::<StorageTreeCopyBinding>)
            .transpose()?;
        if let Some(binding) = &binding {
            ensure!(
                binding.matches_component_scope(
                    id,
                    &context.component.domain,
                    &context.operation_directory.directory_identity()?,
                    &context.component.source_identity,
                    &intent.staging_identity
                ),
                "STORAGE_TREE_MANIFEST_CONFLICT"
            );
        }
        let copy = binding
            .as_ref()
            .map(|binding| CancellationCopy::read(&operation, binding))
            .transpose()?;
        let empty = StorageTreeInventory {
            root_identity: intent.staging_identity.clone(),
            entries: Vec::new(),
        };
        let expected = copy.as_ref().map_or(&empty, |copy| &copy.inventory);
        let actual = directory
            .as_ref()
            .map(|root| inspect_cancellation_target(root, expected, &controls))
            .transpose()?
            .unwrap_or_else(|| empty.clone());
        prepared.push(CancellationComponent {
            context,
            directory,
            path,
            name,
            container,
            actual,
            copy,
        });
    }
    Ok(prepared)
}
