//! One bounded backlink from a prepared component to its original publication.
use super::*;
use crate::PortableLeaseIdentity;
use kcoder_types::{StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase};
use std::{fs::File, io::Read};

pub(super) const LEAF: &str = "kcoder-storage-pending.json";
const LIMIT: u64 = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Backlink {
    version: u8,
    operation_id: String,
    domain: String,
    root_identity: String,
    control_directory: PathBuf,
    control_identity: String,
}

fn identity(file: &File) -> Result<String> {
    Ok(serde_json::to_string(
        &PortableLeaseIdentity::from_private_regular_handle(file)?,
    )?)
}

fn read(root: &PrivateDirectory) -> Result<Option<(Backlink, File)>> {
    let (file, bytes) = match document(root, LEAF, LIMIT) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let record: Backlink = serde_json::from_slice(&bytes)?;
    ensure!(
        record.version == 1
            && super::super::resolve::valid_operation_id(&record.operation_id)
            && record.root_identity == root.directory_identity()?
            && record.control_directory.is_absolute()
            && record.control_directory.file_name() == Some(OsStr::new(".config")),
        "STORAGE_MIGRATION_PENDING"
    );
    owner_key(&record.domain)?;
    Ok(Some((record, file)))
}

fn document(root: &PrivateDirectory, name: &str, limit: u64) -> Result<(File, Vec<u8>)> {
    let mut file = root.open_single_link_regular_file(OsStr::new(name))?;
    let expected = identity(&file)?;
    let before = file.metadata()?;
    ensure!(before.len() <= limit, "STORAGE_MIGRATION_PENDING");
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 <= limit
            && before.len() == after.len()
            && before.modified()? == after.modified()?
            && identity(&file)? == expected
            && identity(&root.open_single_link_regular_file(OsStr::new(name))?)? == expected,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok((file, bytes))
}

fn operation_record(
    control: &PrivateDirectory,
    id: &str,
) -> Result<(StorageMigrationReceipt, String)> {
    ensure!(
        super::super::resolve::valid_operation_id(id),
        "STORAGE_MIGRATION_PENDING"
    );
    let operations = control.open_child(OsStr::new("kcoder-storage-migrations"), false)?;
    let operation = operations.open_child(OsStr::new(id), false)?;
    let identity = operation.directory_identity()?;
    let (_file, bytes) = document(&operation, "receipt.json", 1024 * 1024)?;
    let receipt: StorageMigrationReceipt = serde_json::from_slice(&bytes)?;
    super::super::control::check_receipt(&receipt)?;
    ensure!(
        receipt.plan.operation_id == id
            && operations
                .open_child(OsStr::new(id), false)?
                .directory_identity()?
                == identity,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok((receipt, identity))
}

fn control_key(domain: &str) -> Result<String> {
    owner_key(domain)?;
    Ok(format!("pending-{domain}"))
}

fn proof<'a>(receipt: &'a StorageMigrationReceipt, domain: &str) -> Result<Option<&'a str>> {
    let Some(value) = receipt.owner_receipts.get(&control_key(domain)?) else {
        return Ok(None);
    };
    ensure!(
        value.as_object().is_some_and(|object| object.len() == 1),
        "STORAGE_MIGRATION_PENDING"
    );
    Ok(Some(
        value
            .get("identity")
            .and_then(serde_json::Value::as_str)
            .context("STORAGE_MIGRATION_PENDING")?,
    ))
}

fn authenticate(record: &Backlink, file: &File, receipt: &StorageMigrationReceipt) -> Result<()> {
    ensure!(
        proof(receipt, &record.domain)? == Some(identity(file)?.as_str()),
        "STORAGE_MIGRATION_PENDING"
    );
    Ok(())
}

fn in_place(
    plan: &kcoder_types::StorageMigrationPlan,
    component: &StorageMigrationComponent,
    root_identity: &str,
) -> Result<bool> {
    let source = super::super::resolve::absolute(&component.source)?;
    let destination = super::super::resolve::absolute(&component.destination)?;
    if source != destination {
        return Ok(false);
    }
    ensure!(
        source == super::super::resolve::absolute(&plan.from.data_root)?
            && source == super::super::resolve::absolute(&plan.target.data_root)?
            && component.source_identity == root_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    for binding in &plan.target_bindings {
        if super::super::resolve::absolute(&binding.path)? == destination {
            ensure!(
                super::super::resolve::absolute(&binding.existing_ancestor)? == destination
                    && binding.ancestor_identity == root_identity,
                "STORAGE_MIGRATION_PENDING"
            );
        }
    }
    Ok(true)
}

/// Validate the original in-place control fact without taking writer authority.
pub(in crate::storage) fn verify_in_place_control(
    home: &Path,
    receipt: &StorageMigrationReceipt,
) -> Result<()> {
    let domain = kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN;
    if proof(receipt, domain)?.is_none() {
        return Ok(());
    }
    let component = receipt
        .plan
        .components
        .iter()
        .find(|part| part.domain == domain)
        .context("STORAGE_MIGRATION_PENDING")?;
    let root = PrivateDirectory::open_existing(&component.destination)?;
    let root_identity = root.directory_identity()?;
    ensure!(
        in_place(&receipt.plan, component, &root_identity)?,
        "STORAGE_MIGRATION_PENDING"
    );
    let control_directory = super::super::resolve::absolute(&home.join(".config"))?;
    let control = PrivateDirectory::open_existing(&control_directory)?;
    let expected = Backlink {
        version: 1,
        operation_id: receipt.plan.operation_id.clone(),
        domain: domain.into(),
        root_identity,
        control_directory,
        control_identity: control.directory_identity()?,
    };
    let (file, bytes) = match document(&root, LEAF, LIMIT) {
        Ok(value) => value,
        Err(error) if missing(&error) && receipt.phase == Phase::Stopping => {
            document(&root, &prepared_name(&expected), LIMIT)?
        }
        Err(error)
            if missing(&error)
                && receipt.phase == Phase::Verified
                && receipt.disposition == Disposition::Complete =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    ensure!(
        serde_json::from_slice::<Backlink>(&bytes)? == expected,
        "STORAGE_MIGRATION_PENDING"
    );
    authenticate(&expected, &file, receipt)
}

fn original(
    record: &Backlink,
    owned_control: Option<&PrivateDirectory>,
) -> Result<(StorageMigrationReceipt, PrivateDirectory, Option<File>)> {
    let control = PrivateDirectory::open_existing(&record.control_directory)?;
    ensure!(
        control.directory_identity()? == record.control_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    let owned = owned_control
        .map(|held| held.directory_identity())
        .transpose()?
        .as_ref()
        == Some(&record.control_identity);
    let gate = if owned {
        None
    } else {
        Some(
            control
                .try_existing_shared_lock(OsStr::new("kcoder-storage.lock"))?
                .context("STORAGE_MIGRATION_PENDING")?,
        )
    };
    if let Some(gate) = &gate {
        ensure!(
            gate.metadata()?.len() == 0
                && identity(gate)?
                    == identity(
                        &control
                            .open_single_link_regular_file(OsStr::new("kcoder-storage.lock"))?
                    )?,
            "STORAGE_MIGRATION_PENDING"
        );
    }
    let (receipt, operation_identity) = operation_record(&control, &record.operation_id)?;
    let mut components = receipt
        .plan
        .components
        .iter()
        .filter(|part| part.domain == record.domain);
    let component = components.next().context("STORAGE_MIGRATION_PENDING")?;
    ensure!(components.next().is_none(), "STORAGE_MIGRATION_PENDING");
    let scopes = active_component_directory_scopes(&receipt)?;
    if !in_place(&receipt.plan, component, &record.root_identity)? {
        let intent = read_intent(&receipt, &owner_key(&record.domain)?)?
            .context("STORAGE_MIGRATION_PENDING")?;
        ensure!(
            receipt.plan.operation_id == record.operation_id
                && intent.operation_id == record.operation_id
                && intent.domain == record.domain
                && intent.source_identity == component.source_identity
                && intent.destination == super::super::resolve::absolute(&component.destination)?
                && intent.staging_identity == record.root_identity
                && scopes.get(&intent.destination) == Some(&record.root_identity)
                && intent.operation_directory_identity == operation_identity,
            "STORAGE_MIGRATION_PENDING"
        );
    }
    ensure!(
        PrivateDirectory::open_existing(&record.control_directory)?.directory_identity()?
            == record.control_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok((receipt, control, gate))
}

fn complete(
    record: &Backlink,
    receipt: &StorageMigrationReceipt,
    control: &PrivateDirectory,
) -> Result<()> {
    ensure!(
        receipt.disposition == Disposition::Complete
            && receipt.phase == Phase::Verified
            && receipt.error_code.is_none(),
        "STORAGE_MIGRATION_PENDING"
    );
    let (_file, bytes) = document(control, "kcoder-storage.json", LIMIT)?;
    let selected: kcoder_types::StorageLocationRecord = serde_json::from_slice(&bytes)?;
    super::super::validate_storage_location_record(&selected)?;
    if selected.operation_id.as_deref() == Some(&record.operation_id) {
        ensure!(selected == receipt.plan.target, "STORAGE_MIGRATION_PENDING");
    } else {
        // One direct selector receipt, never an original/predecessor chain.
        let id = selected
            .operation_id
            .as_deref()
            .context("STORAGE_MIGRATION_PENDING")?;
        let (current, _) = operation_record(control, id)?;
        ensure!(
            current.disposition == Disposition::Complete
                && current.phase == Phase::Verified
                && current.error_code.is_none()
                && current.plan.target == selected,
            "STORAGE_MIGRATION_PENDING"
        );
    }
    let component = receipt
        .plan
        .components
        .iter()
        .find(|part| part.domain == record.domain)
        .context("STORAGE_MIGRATION_PENDING")?;
    if !in_place(&receipt.plan, component, &record.root_identity)? {
        let intent = read_intent(receipt, &owner_key(&record.domain)?)?
            .context("STORAGE_MIGRATION_PENDING")?;
        let copied: StorageTreeCopyBinding = serde_json::from_value(
            receipt
                .owner_receipts
                .get(&format!("copy-{}", record.domain))
                .context("STORAGE_MIGRATION_PENDING")?
                .clone(),
        )?;
        ensure!(
            copied.matches_component_scope(
                &record.operation_id,
                &record.domain,
                &intent.operation_directory_identity,
                &component.source_identity,
                &record.root_identity
            ) && intent
                .container
                .as_ref()
                .is_none_or(|container| container.published_copy.as_ref() == Some(&copied)),
            "STORAGE_MIGRATION_PENDING"
        );
    }
    ensure!(
        PrivateDirectory::open_existing(&component.destination)?.directory_identity()?
            == record.root_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    let original_data = super::super::resolve::absolute(&receipt.plan.target.data_root)?;
    let destination = super::super::resolve::absolute(&component.destination)?;
    let relative = destination.strip_prefix(original_data)?;
    ensure!(
        PrivateDirectory::open_existing(&selected.data_root.join(relative))?
            .directory_identity()?
            == record.root_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok(())
}

pub(in crate::storage) fn admitted(root: &PrivateDirectory) -> Result<()> {
    let Some((record, file)) = read(root).context("STORAGE_MIGRATION_PENDING")? else {
        return Ok(());
    };
    let (receipt, control, gate) = original(&record, None).context("STORAGE_MIGRATION_PENDING")?;
    authenticate(&record, &file, &receipt).context("STORAGE_MIGRATION_PENDING")?;
    complete(&record, &receipt, &control).context("STORAGE_MIGRATION_PENDING")?;
    let destination = &receipt
        .plan
        .components
        .iter()
        .find(|part| part.domain == record.domain)
        .context("STORAGE_MIGRATION_PENDING")?
        .destination;
    let path = super::super::resolve::absolute(destination)?;
    let lease = super::super::writers::RootLease::existing_identity_probe(&path)?
        .context("STORAGE_MIGRATION_PENDING")?;
    super::super::active_operation::assert_active_operation_outside_roots(
        record
            .control_directory
            .parent()
            .context("STORAGE_MIGRATION_PENDING")?,
        &[path.as_path()],
        &[lease],
    )
    .context("STORAGE_MIGRATION_PENDING")?;
    ensure!(
        identity(&file)? == identity(&root.open_single_link_regular_file(OsStr::new(LEAF))?)?
            && control.directory_identity()? == record.control_identity
            && PrivateDirectory::open_existing(&record.control_directory)?.directory_identity()?
                == record.control_identity,
        "STORAGE_MIGRATION_PENDING"
    );
    drop(gate);
    Ok(())
}

fn prepared_name(record: &Backlink) -> String {
    format!(".kcoder-pending-{}-{}", record.operation_id, record.domain)
}

fn prepare_owned(
    root: &PrivateDirectory,
    record: &Backlink,
    known: Option<&str>,
    mut save: impl FnMut(String) -> Result<()>,
) -> Result<()> {
    if let Some((existing, file)) = read(root)? {
        ensure!(
            existing == *record && known == Some(identity(&file)?.as_str()),
            "STORAGE_MIGRATION_PENDING"
        );
        return Ok(());
    }
    let name = prepared_name(record);
    let file = if let Some(expected) = known {
        let (file, bytes) = document(root, &name, LIMIT)?;
        ensure!(
            identity(&file)? == expected && serde_json::from_slice::<Backlink>(&bytes)? == *record,
            "STORAGE_MIGRATION_PENDING"
        );
        file
    } else {
        match document(root, &name, LIMIT) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("STORAGE_MIGRATION_PENDING"),
        }
        let bytes = serde_json::to_vec(record)?;
        ensure!(bytes.len() as u64 <= LIMIT, "STORAGE_MIGRATION_PENDING");
        // Record the flushed descriptor before the fixed preparation name exists.
        // A crash before that receipt leaves only an unknown atomic-write temp;
        // it must never strand an unreceipted control leaf on the business root.
        let mut recorded = None;
        root.atomic_publish_observed_from_reader(
            OsStr::new(&name),
            &mut bytes.as_slice(),
            false,
            || Ok(()),
            |file| {
                save(identity(file)?)?;
                recorded = Some(file.try_clone()?);
                Ok(())
            },
        )?;
        recorded.context("STORAGE_MIGRATION_PENDING")?
    };
    ensure!(
        identity(&file)? == identity(&root.open_single_link_regular_file(OsStr::new(&name))?)?,
        "STORAGE_MIGRATION_PENDING"
    );
    root.rename_no_replace(OsStr::new(&name), OsStr::new(LEAF))?;
    ensure!(
        identity(&file)? == identity(&root.open_single_link_regular_file(OsStr::new(LEAF))?)?,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok(())
}

pub(super) fn prepare(
    coordinator: &mut StorageCoordinator,
    id: &str,
    domain: &str,
    root: &PrivateDirectory,
) -> Result<()> {
    let (receipt, control, _) = coordinator.source_retirement_context(id)?;
    let record = Backlink {
        version: 1,
        operation_id: id.into(),
        domain: domain.into(),
        root_identity: root.directory_identity()?,
        control_directory: coordinator.source_retirement_control_path()?,
        control_identity: control.directory_identity()?,
    };
    let key = control_key(domain)?;
    prepare_owned(root, &record, proof(&receipt, domain)?, |identity| {
        coordinator.record_owner_receipt(
            id,
            &key,
            None,
            serde_json::json!({"identity":identity}),
        )?;
        Ok(())
    })
}

fn held_root(
    path: &Path,
    expected: &str,
    held: &[super::super::writers::RootLease],
) -> Result<PrivateDirectory> {
    let root = PrivateDirectory::open_existing(path)?;
    ensure!(
        root.directory_identity()? == expected
            && held
                .iter()
                .try_fold(false, |found, lease| Ok::<_, anyhow::Error>(
                    found || lease.matches_directory(expected)?
                ))?,
        "STORAGE_MIGRATION_PENDING"
    );
    Ok(root)
}

fn remove_owned(root: &PrivateDirectory, record: &Backlink, expected: Option<&str>) -> Result<()> {
    let prepared = prepared_name(record);
    for name in [LEAF, prepared.as_str()] {
        match document(root, name, LIMIT) {
            Ok((file, bytes)) => {
                ensure!(
                    expected == Some(identity(&file)?.as_str())
                        && serde_json::from_slice::<Backlink>(&bytes)? == *record,
                    "STORAGE_MIGRATION_PENDING"
                );
                #[cfg(windows)]
                root.remove_regular_file_if_handle(OsStr::new(name), &file)?;
                #[cfg(not(windows))]
                root.remove_regular_file(OsStr::new(name))?;
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Completion releases only authenticated control leaves under target fences.
/// A lost acknowledgement never reopens the old source or repeats a publication.
pub(in crate::storage) fn cleanup_complete(
    receipt: &StorageMigrationReceipt,
    control: &PrivateDirectory,
    path: &Path,
    held: &mut Vec<super::super::writers::RootLease>,
) -> Result<()> {
    for component in &receipt.plan.components {
        let known = proof(receipt, &component.domain)?;
        let root = match PrivateDirectory::open_existing(&component.destination) {
            Ok(root) => root,
            Err(error) if missing(&error) && known.is_none() => continue,
            Err(error) => return Err(error),
        };
        let Some((record, file)) = read(&root)? else {
            continue;
        };
        let root_identity = root.directory_identity()?;
        if !in_place(&receipt.plan, component, &root_identity)? {
            let intent = read_intent(receipt, &owner_key(&component.domain)?)?
                .context("STORAGE_MIGRATION_PENDING")?;
            ensure!(
                intent.staging_identity == root_identity,
                "STORAGE_MIGRATION_PENDING"
            );
        }
        if let Some(lease) =
            super::super::writers::RootLease::exclusive_existing(&component.destination, held)?
        {
            held.push(lease);
        }
        held_root(&component.destination, &root_identity, held)?;
        ensure!(
            record.domain == component.domain,
            "STORAGE_MIGRATION_PENDING"
        );
        if record.operation_id == receipt.plan.operation_id {
            ensure!(
                record.control_directory == path
                    && record.control_identity == control.directory_identity()?,
                "STORAGE_MIGRATION_PENDING"
            );
            authenticate(&record, &file, receipt)?;
        } else {
            ensure!(
                in_place(&receipt.plan, component, &root_identity)?,
                "STORAGE_MIGRATION_PENDING"
            );
        }
        let (original, original_control, _gate) = original(&record, Some(control))?;
        complete(&record, &original, &original_control)?;
        remove_owned(&root, &record, proof(&original, &record.domain)?)?;
    }
    Ok(())
}

/// Reuse the stopped plan for an in-place root; no publication/copy is invented.
pub(in crate::storage) fn prepare_in_place(
    receipt: &mut StorageMigrationReceipt,
    control: &PrivateDirectory,
    path: &Path,
    held: &[super::super::writers::RootLease],
    mut save: impl FnMut(&StorageMigrationReceipt) -> Result<()>,
) -> Result<()> {
    for component in receipt.plan.components.clone() {
        if component.source != component.destination
            || component.source != receipt.plan.from.data_root
        {
            continue;
        }
        ensure!(
            in_place(&receipt.plan, &component, &component.source_identity)?,
            "STORAGE_MIGRATION_PENDING"
        );
        let root = held_root(&component.source, &component.source_identity, held)?;
        let record = Backlink {
            version: 1,
            operation_id: receipt.plan.operation_id.clone(),
            domain: component.domain.clone(),
            root_identity: component.source_identity.clone(),
            control_directory: path.into(),
            control_identity: control.directory_identity()?,
        };
        if let Some((existing, file)) = read(&root)? {
            if existing != record {
                let (previous, previous_control, _gate) = original(&existing, Some(control))?;
                authenticate(&existing, &file, &previous)?;
                complete(&existing, &previous, &previous_control)?;
                continue;
            }
        }
        let known = proof(receipt, &component.domain)?.map(str::to_owned);
        let key = control_key(&component.domain)?;
        prepare_owned(&root, &record, known.as_deref(), |identity| {
            receipt
                .owner_receipts
                .insert(key.clone(), serde_json::json!({"identity":identity}));
            save(receipt)
        })?;
    }
    Ok(())
}

pub(in crate::storage) fn cleanup_in_place(
    receipt: &mut StorageMigrationReceipt,
    control: &PrivateDirectory,
    path: &Path,
    held: &[super::super::writers::RootLease],
) -> Result<()> {
    for component in receipt.plan.components.clone() {
        if component.source != component.destination
            || component.source != receipt.plan.from.data_root
        {
            continue;
        }
        ensure!(
            in_place(&receipt.plan, &component, &component.source_identity)?,
            "STORAGE_MIGRATION_PENDING"
        );
        let root = PrivateDirectory::open_existing(&component.source)?;
        let existing = read(&root)?;
        if let Some((record, file)) = &existing {
            if record.operation_id != receipt.plan.operation_id {
                let (previous, previous_control, _gate) = original(record, Some(control))?;
                authenticate(record, file, &previous)?;
                complete(record, &previous, &previous_control)?;
                continue;
            }
            ensure!(
                record.control_directory == path
                    && record.control_identity == control.directory_identity()?
                    && record.domain == component.domain,
                "STORAGE_MIGRATION_PENDING"
            );
            authenticate(record, file, receipt)?;
        }
        let record = Backlink {
            version: 1,
            operation_id: receipt.plan.operation_id.clone(),
            domain: component.domain.clone(),
            root_identity: component.source_identity.clone(),
            control_directory: path.into(),
            control_identity: control.directory_identity()?,
        };
        let expected = proof(receipt, &component.domain)?;
        if expected.is_some() {
            held_root(&component.source, &component.source_identity, held)?;
        }
        remove_owned(&root, &record, expected)?;
        receipt
            .owner_receipts
            .remove(&control_key(&component.domain)?);
    }
    Ok(())
}

/// Only declared source roots under this operation's actual exclusive fences
/// may contribute exclusions. Equal filenames elsewhere remain ordinary data.
pub(in crate::storage) fn source_controls(
    coordinator: &mut StorageCoordinator,
    id: &str,
) -> Result<Vec<File>> {
    let (receipt, control, _) = coordinator.source_retirement_context(id)?;
    let mut paths = BTreeSet::from([
        receipt.plan.from.data_root,
        receipt.plan.from.gateway_root,
        receipt.plan.from.desktop_root,
    ]);
    paths.extend(
        receipt
            .plan
            .components
            .iter()
            .map(|part| part.source.clone()),
    );
    let mut files = Vec::new();
    for path in paths {
        let root = match PrivateDirectory::open_existing(&path) {
            Ok(root) => root,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let Some((record, file)) = read(&root).context("STORAGE_MIGRATION_PENDING")? else {
            continue;
        };
        coordinator.verify_source_root(id, &path, &root.directory_identity()?)?;
        let (previous, previous_control, _gate) =
            original(&record, Some(&control)).context("STORAGE_MIGRATION_PENDING")?;
        authenticate(&record, &file, &previous).context("STORAGE_MIGRATION_PENDING")?;
        if record.operation_id == id {
            let component = previous
                .plan
                .components
                .iter()
                .find(|part| part.domain == record.domain)
                .context("STORAGE_MIGRATION_PENDING")?;
            ensure!(
                in_place(&previous.plan, component, &record.root_identity)?,
                "STORAGE_MIGRATION_PENDING"
            );
        } else {
            complete(&record, &previous, &previous_control).context("STORAGE_MIGRATION_PENDING")?;
        }
        files.push(file);
    }
    Ok(files)
}

pub(in crate::storage) fn target_control(
    coordinator: &mut StorageCoordinator,
    id: &str,
    root: &PrivateDirectory,
) -> Result<Option<File>> {
    // copy_component_checked already holds the original stopped coordinator.
    let Some((record, file)) = read(root)? else {
        return Ok(None);
    };
    ensure!(record.operation_id == id, "STORAGE_MIGRATION_PENDING");
    let (_, control, _) = coordinator.source_retirement_context(id)?;
    let (receipt, _, _gate) = original(&record, Some(&control))?;
    authenticate(&record, &file, &receipt)?;
    Ok(Some(file))
}

pub(in crate::storage) fn control_identity(file: &File) -> Result<String> {
    identity(file)
}
