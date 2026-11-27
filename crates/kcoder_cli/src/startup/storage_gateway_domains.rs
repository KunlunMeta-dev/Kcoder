//! Offline Gateway wiring. The coordinator owns shutdown; each existing Node
//! owner prepares, transfers and reads its own records through one helper.
use super::storage_owner_child::run_offline_owner_child;
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory,
    storage::{
        StorageCoordinator, StoragePublishedComponent, StorageTreeEntryKind, StorageTreeInventory,
        node_storage_path, node_storage_relative_path,
    },
};
use kcoder_types::{
    StorageLayout, StorageMigrationComponent, StorageMigrationPlan, StorageMigrationReceipt,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

#[path = "storage_gateway_domains/channels.rs"]
mod channels;
use channels::ChannelRead;
#[path = "storage_gateway_domains/internal_references.rs"]
mod internal_references;

const TIMEOUT: Duration = Duration::from_secs(120);
const INVALID: &str = "STORAGE_OFFLINE_CHILD_RESULT_INVALID";

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn directory(root: &PrivateDirectory, path: &Path) -> Result<Option<PrivateDirectory>> {
    let mut current = root.duplicate_handle()?;
    for part in path.components() {
        let Component::Normal(name) = part else {
            anyhow::bail!("STORAGE_GATEWAY_PATH_INVALID")
        };
        current = match current.open_child(name, false) {
            Ok(child) => child,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
    }
    Ok(Some(current))
}
fn file_present(root: &PrivateDirectory, name: &str) -> Result<bool> {
    match root.open_regular_file(OsStr::new(name)) {
        Ok(_) => Ok(true),
        Err(error) if missing(&error) => Ok(false),
        Err(error) => Err(error),
    }
}
fn read_json(root: &PrivateDirectory, name: &str) -> Result<Value> {
    let mut file = root.open_single_link_regular_file(OsStr::new(name))?;
    let before = observed_file(&file)?;
    let mut bytes = Vec::new();
    (&mut file).take(8193).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 8192
            && observed_file(&file)? == before
            && observed_file(&root.open_single_link_regular_file(OsStr::new(name))?)? == before,
        "STORAGE_GATEWAY_OWNER_CHANGED"
    );
    serde_json::from_slice(&bytes).context("STORAGE_GATEWAY_OWNER_INVALID")
}
fn observed_file(file: &File) -> Result<(String, u64)> {
    let (identity, links) = PortableLeaseIdentity::observe_regular_handle_metadata(file)?;
    Ok((serde_json::to_string(&identity)?, links))
}
fn matches_node_path(value: &Value, expected: &Path) -> bool {
    value.as_str().is_some_and(|path| {
        node_storage_relative_path(Path::new(path), expected)
            .is_ok_and(|relative| relative.as_os_str().is_empty())
    })
}

struct RelayTransfer {
    projection: PathBuf,
    projection_file: Option<File>,
    marker_file: File,
    reference: PathBuf,
    reference_root: PrivateDirectory,
    reference_file: File,
    reference_value: Value,
    epoch: PathBuf,
    epoch_root: PrivateDirectory,
    receipt: Option<RelayTransferReceipt>,
}

struct RelayTransferReceipt {
    path: PathBuf,
    root: PrivateDirectory,
    file: File,
    value: Value,
}

/// These are original source observations, not a second migration authority.
/// The caller retains the one stopped coordinator across copy and publication.
pub(super) struct GatewayDomainsSource {
    operation_id: String,
    component: StorageMigrationComponent,
    component_root: PrivateDirectory,
    relative: PathBuf,
    gateway: Option<PrivateDirectory>,
    entries: Vec<Value>,
    channels: Option<ChannelRead>,
    relays: Vec<RelayTransfer>,
    prepared_relay_values: BTreeMap<String, Value>,
    exclusions: BTreeSet<PathBuf>,
}
impl GatewayDomainsSource {
    fn observe(plan: &StorageMigrationPlan) -> Result<Self> {
        ensure!(
            !plan.from.externally_configured
                && (plan.from.layout == StorageLayout::Unified
                    && plan.from.gateway_root == plan.from.data_root.join("studio/gateway")
                    || plan.from.layout == StorageLayout::Legacy
                        && plan
                            .components
                            .iter()
                            .any(|component| component.domain == "gateway"
                                && component.source == plan.from.gateway_root
                                && component.destination
                                    == plan.target.data_root.join("studio/gateway"))),
            "STORAGE_GATEWAY_SOURCE_UNSUPPORTED"
        );
        let source = &plan.from.gateway_root;
        let target = plan.target.data_root.join("studio/gateway");
        ensure!(*source != target, "STORAGE_GATEWAY_IN_PLACE");
        let mut matching = plan.components.iter().filter_map(|component| {
            let relative = source.strip_prefix(&component.source).ok()?;
            (component.destination.join(relative) == target)
                .then_some((component, relative.to_path_buf()))
        });
        let (component, relative) = matching
            .next()
            .context("STORAGE_GATEWAY_COMPONENT_REQUIRED")?;
        ensure!(
            matching.next().is_none(),
            "STORAGE_GATEWAY_COMPONENT_CONFLICT"
        );
        let component_root = PrivateDirectory::open_existing(&component.source)?;
        ensure!(
            component_root.directory_identity()? == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        let gateway = directory(&component_root, &relative)?;
        Ok(Self {
            operation_id: plan.operation_id.clone(),
            component: component.clone(),
            component_root,
            relative,
            gateway,
            entries: Vec::new(),
            channels: None,
            relays: Vec::new(),
            prepared_relay_values: BTreeMap::new(),
            exclusions: BTreeSet::new(),
        })
    }
    fn source(&self) -> PathBuf {
        if self.relative.as_os_str().is_empty() {
            self.component.source.clone()
        } else {
            self.component.source.join(&self.relative)
        }
    }
    fn target(&self) -> PathBuf {
        if self.relative.as_os_str().is_empty() {
            self.component.destination.clone()
        } else {
            self.component.destination.join(&self.relative)
        }
    }
    fn discover(&mut self) -> Result<()> {
        let Some(root) = &self.gateway else {
            return Ok(());
        };
        self.entries.push(json!({"kind":"productAccountCookieScope","source":node_storage_path(&self.source())?,"finalTarget":node_storage_path(&self.target())?}));
        for (kind, name, files) in [
            (
                "mobile",
                "mobile-device-auth",
                &["devices.json", ".key"][..],
            ),
            ("channels", "channels", &["channels.sqlite3"][..]),
        ] {
            let Some(store) = directory(root, Path::new(name))? else {
                continue;
            };
            let present = files
                .iter()
                .map(|name| file_present(&store, name))
                .collect::<Result<Vec<_>>>()?;
            ensure!(
                present.iter().all(|value| *value) || present.iter().all(|value| !*value),
                "GATEWAY_OFFLINE_STORE_INCOMPLETE"
            );
            if present.iter().any(|value| *value) {
                self.entries.push(json!({"kind":kind,"source":node_storage_path(&if kind == "mobile" {self.source()} else {self.source().join(name)})?,
                    "finalTarget":node_storage_path(&if kind == "mobile" {self.target()} else {self.target().join(name)})?}));
            } else {
                ensure!(
                    store
                        .entry_names_bounded(65_536)?
                        .iter()
                        .all(|name| name == OsStr::new("kcoder-storage-writers.lock")
                            || name == OsStr::new("kcoder-storage-instances.lock")),
                    "STORAGE_GATEWAY_OWNER_UNRECOGNIZED"
                );
            }
        }
        self.entries
            .extend(self.relay_entries(root, Path::new(""))?);
        if let Some(profiles) = directory(root, Path::new("relay-profiles"))? {
            for name in profiles.entry_names_bounded(128)? {
                if name == OsStr::new("kcoder-storage-writers.lock")
                    || name == OsStr::new("kcoder-storage-instances.lock")
                {
                    continue;
                }
                let value = name
                    .to_str()
                    .context("STORAGE_GATEWAY_RELAY_PROFILE_UNSUPPORTED")?;
                ensure!(
                    value.len() == 36
                        && value.bytes().all(|byte| byte.is_ascii_digit()
                            || (b'a'..=b'f').contains(&byte)
                            || byte == b'-'),
                    "STORAGE_GATEWAY_RELAY_PROFILE_UNSUPPORTED"
                );
                self.entries.extend(self.relay_entries(
                    &profiles.open_child(&name, false)?,
                    &Path::new("relay-profiles").join(name),
                )?);
            }
        }
        ensure!(
            self.entries.len() <= 128,
            "STORAGE_GATEWAY_OWNER_BUDGET_EXCEEDED"
        );
        Ok(())
    }
    fn relay_entries(&self, root: &PrivateDirectory, relative: &Path) -> Result<Vec<Value>> {
        let mut entries = Vec::new();
        let mut source = self.source();
        let mut target = self.target();
        if !relative.as_os_str().is_empty() {
            source.push(relative);
            target.push(relative);
        }
        let mut shared_epoch = None;
        let mut canonical = Vec::new();
        for name in ["relay", "desktop-relay"] {
            let Some(identity) = directory(root, Path::new(name))? else {
                continue;
            };
            let reference = directory(&identity, Path::new("client-identity.json.state-v2"))?;
            if !file_present(&identity, "client-identity.json")? && reference.is_none() {
                continue;
            }
            let mut epoch_fact = None;
            let mut is_canonical = false;
            let origin = if let Some(reference) = reference {
                let reference = read_json(&reference, "reference.json")?;
                let epoch = PathBuf::from(
                    reference["epoch"]
                        .as_str()
                        .context("STORAGE_GATEWAY_RELAY_REFERENCE_INVALID")?,
                );
                let mut epoch = directory(
                    self.gateway.as_ref().expect("observed Gateway"),
                    &node_storage_relative_path(&epoch, &self.source())
                        .context("STORAGE_GATEWAY_RELAY_EXTERNAL_EPOCH_UNSUPPORTED")?,
                )?
                .context("STORAGE_GATEWAY_RELAY_REFERENCE_INVALID")?;
                epoch_fact = Some((
                    epoch.directory_identity()?,
                    reference["generation"]
                        .as_str()
                        .context(INVALID)?
                        .to_owned(),
                ));
                is_canonical = reference["role"] == "canonical";
                let mut record = Value::Null;
                for depth in 0..3 {
                    record = read_json(&epoch, "entry.json")?;
                    let Some(next) = directory(&epoch, Path::new("next"))? else {
                        break;
                    };
                    ensure!(depth < 2, "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID");
                    epoch = next;
                }
                record["record"]["relayOrigin"].as_str().map(str::to_owned)
            } else {
                read_json(&identity, "client-identity.json")?["relayOrigin"]
                    .as_str()
                    .map(str::to_owned)
            };
            if !entries.is_empty() {
                ensure!(
                    epoch_fact.is_some() && epoch_fact == shared_epoch,
                    "STORAGE_GATEWAY_RELAY_DUAL_IDENTITY_UNSUPPORTED"
                );
            } else {
                shared_epoch = epoch_fact;
            }
            canonical.push(is_canonical);
            let origin = match origin {
                Some(origin) => origin,
                None => read_json(root, "desktop-relay.json")?["url"]
                    .as_str()
                    .context("STORAGE_GATEWAY_RELAY_ORIGIN_REQUIRED")?
                    .to_owned(),
            };
            let secret = directory(root, Path::new("desktop-relay"))?
                .context("GATEWAY_RELOCATION_SECRET_MISMATCH")?;
            ensure!(
                file_present(&secret, "gateway-secret")?,
                "GATEWAY_RELOCATION_SECRET_MISMATCH"
            );
            entries.push(json!({"kind":"relay","source":node_storage_path(&source)?,"finalTarget":node_storage_path(&target)?,
                "relayUrl":origin,"sourceIdentityFile":Path::new(name).join("client-identity.json")}));
        }
        if entries.len() == 2 {
            if canonical[1] && !canonical[0] {
                entries.swap(0, 1);
            }
            entries[1]["sharedIdentityFile"] = entries[0]["sourceIdentityFile"].clone();
        }
        Ok(entries)
    }
    pub(super) fn component_domain(&self) -> &str {
        &self.component.domain
    }
    pub(super) fn copy_exclusions(&self) -> &BTreeSet<PathBuf> {
        &self.exclusions
    }
    fn verify_paths(&self) -> Result<()> {
        if let Some(channels) = &self.channels {
            channels.verify()?;
        }
        ensure!(
            PrivateDirectory::open_existing(&self.component.source)?.directory_identity()?
                == self.component.source_identity
                && self.component_root.directory_identity()? == self.component.source_identity,
            "STORAGE_GATEWAY_SOURCE_CHANGED"
        );
        let current = directory(&self.component_root, &self.relative)?;
        ensure!(
            match (&self.gateway, current) {
                (None, None) => true,
                (Some(held), Some(current)) =>
                    held.directory_identity()? == current.directory_identity()?,
                _ => false,
            },
            "STORAGE_GATEWAY_SOURCE_CHANGED"
        );
        for relay in &self.relays {
            for (path, held) in [
                (&relay.reference, &relay.reference_root),
                (&relay.epoch, &relay.epoch_root),
            ] {
                let current = directory(&self.component_root, path)?
                    .context("STORAGE_GATEWAY_RELAY_SOURCE_CHANGED")?;
                ensure!(
                    current.directory_identity()? == held.directory_identity()?,
                    "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
                );
            }
            let parent = directory(
                &self.component_root,
                relay.projection.parent().context(INVALID)?,
            )?
            .context(INVALID)?;
            let projection =
                match parent.open_regular_file(relay.projection.file_name().context(INVALID)?) {
                    Ok(file) => Some(file),
                    Err(error) if missing(&error) => None,
                    Err(error) => return Err(error),
                };
            ensure!(
                match (&relay.projection_file, &projection) {
                    (None, None) => true,
                    (Some(held), Some(current)) => observed_file(held)? == observed_file(current)?,
                    _ => false,
                },
                "STORAGE_GATEWAY_RELAY_LINKS_CHANGED"
            );
            let marker = relay
                .epoch_root
                .open_regular_file(OsStr::new("marker.json"))?;
            ensure!(
                observed_file(&marker)? == observed_file(&relay.marker_file)?,
                "STORAGE_GATEWAY_RELAY_LINKS_CHANGED"
            );
            let (marker_identity, marker_links) = observed_file(&marker)?;
            let mut known_markers = 1;
            for other in &self.relays {
                if let Some(file) = &other.projection_file {
                    known_markers += u64::from(observed_file(file)?.0 == marker_identity);
                }
            }
            ensure!(
                marker_links == known_markers,
                "STORAGE_GATEWAY_RELAY_LINKS_CHANGED"
            );
            if let Some(projection) = &projection {
                let (identity, links) = observed_file(projection)?;
                let mut known = u64::from(observed_file(&marker)?.0 == identity);
                for other in &self.relays {
                    if let Some(file) = &other.projection_file {
                        known += u64::from(observed_file(file)?.0 == identity);
                    }
                }
                ensure!(links == known, "STORAGE_GATEWAY_RELAY_LINKS_CHANGED");
            }
            let reference_file = relay
                .reference_root
                .open_single_link_regular_file(OsStr::new("reference.json"))?;
            ensure!(
                observed_file(&reference_file)? == observed_file(&relay.reference_file)?
                    && read_json(&relay.reference_root, "reference.json")? == relay.reference_value
                    && matches_node_path(
                        &relay.reference_value["epoch"],
                        &self.component.source.join(&relay.epoch)
                    ),
                "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
            );
            if let Some(receipt) = &relay.receipt {
                let current = directory(&self.component_root, &receipt.path)?
                    .context("STORAGE_GATEWAY_RELAY_SOURCE_CHANGED")?;
                let file = current.open_single_link_regular_file(OsStr::new("reference.json"))?;
                let actual = observed_file(&file)?;
                ensure!(
                    current.directory_identity()? == receipt.root.directory_identity()?
                        && actual == observed_file(&receipt.file)?
                        && actual.1 == 1
                        && read_json(&current, "reference.json")? == receipt.value,
                    "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
                );
            }
        }
        Ok(())
    }
    pub(super) fn verify(&self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        ensure!(self.operation_id == id, "STORAGE_OPERATION_CONFLICT");
        // The one coordinator already holds the real stopped root leases.
        coordinator.prepare_offline_child_fences(id)?;
        self.verify_paths()
    }
    pub(super) fn verify_source_inventory(&self, inventory: &StorageTreeInventory) -> Result<()> {
        self.verify_paths()?;
        ensure!(
            inventory.root_identity == self.component.source_identity,
            "STORAGE_GATEWAY_SOURCE_CHANGED"
        );
        let mut owned = BTreeMap::new();
        for relay in &self.relays {
            if let Some(file) = &relay.projection_file {
                owned.insert(
                    relay.projection.clone(),
                    (StorageTreeEntryKind::RegularFile, observed_file(file)?.0),
                );
            }
            owned.insert(
                relay.reference.clone(),
                (
                    StorageTreeEntryKind::Directory,
                    relay.reference_root.directory_identity()?,
                ),
            );
            owned.insert(
                relay.epoch.clone(),
                (
                    StorageTreeEntryKind::Directory,
                    relay.epoch_root.directory_identity()?,
                ),
            );
            if let Some(receipt) = &relay.receipt {
                owned.insert(
                    receipt.path.clone(),
                    (
                        StorageTreeEntryKind::Directory,
                        receipt.root.directory_identity()?,
                    ),
                );
            }
        }
        for path in &self.exclusions {
            let actual = inventory
                .entries
                .iter()
                .find(|entry| &entry.relative_path == path)
                .context("STORAGE_GATEWAY_EXCLUSION_MISSING")?;
            let expected = owned
                .get(path)
                .context("STORAGE_GATEWAY_EXCLUSION_UNOWNED")?;
            ensure!(
                actual.excluded
                    && actual.sha256.is_none()
                    && actual.kind == expected.0
                    && actual.identity == expected.1,
                "STORAGE_GATEWAY_EXCLUSION_CHANGED"
            );
        }
        Ok(())
    }
    fn published(&self, id: &str, published: &StoragePublishedComponent) -> Result<()> {
        ensure!(
            self.operation_id == id
                && published.operation_id() == id
                && published.domain() == self.component.domain
                && published.source_path() == self.component.source
                && published.source_identity() == self.component.source_identity
                && published.destination_path() == self.component.destination,
            "STORAGE_GATEWAY_PUBLICATION_MISMATCH"
        );
        published.verify()?;
        let target = directory(published.directory(), &self.relative)?;
        ensure!(
            self.gateway.is_some() == target.is_some(),
            "STORAGE_GATEWAY_PUBLICATION_MISMATCH"
        );
        if let Some(target) = target {
            ensure!(
                PrivateDirectory::open_existing(&self.target())?.directory_identity()?
                    == target.directory_identity()?,
                "STORAGE_GATEWAY_PUBLICATION_MISMATCH"
            );
        }
        Ok(())
    }
    fn freeze_relay(&mut self, entry: &Value, value: &Value) -> Result<()> {
        let projection = Path::new(entry["source"].as_str().context(INVALID)?)
            .join(entry["sourceIdentityFile"].as_str().context(INVALID)?);
        ensure!(
            value["operationId"] == self.operation_id
                && matches_node_path(&value["identityFile"], &projection),
            "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
        );
        let reference = PathBuf::from(
            value["paths"]["referenceDirectory"]
                .as_str()
                .context(INVALID)?,
        );
        ensure!(
            matches_node_path(
                &value["paths"]["referenceDirectory"],
                &PathBuf::from(format!("{}.state-v2", projection.display()))
            ),
            "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
        );
        let reference = node_storage_relative_path(&reference, &self.component.source)?;
        let reference_root = directory(&self.component_root, &reference)?.context(INVALID)?;
        check_node_identity(&reference_root, &value["identities"]["referenceDirectory"])?;
        let reference_file =
            reference_root.open_single_link_regular_file(OsStr::new("reference.json"))?;
        let original = read_json(&reference_root, "reference.json")?;
        ensure!(
            observed_file(&reference_file)?
                == observed_file(
                    &reference_root.open_single_link_regular_file(OsStr::new("reference.json"))?
                )?,
            "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
        );
        let epoch = PathBuf::from(original["epoch"].as_str().context(INVALID)?);
        let generation = value["generation"].as_str().context(INVALID)?;
        ensure!(
            generation.len() == 64
                && generation
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && original["generation"] == generation
                && matches_node_path(&value["paths"]["epochDirectory"], &epoch)
                && epoch.file_name()
                    == Some(OsStr::new(&format!(
                        ".relay-identity-generation-{generation}"
                    )))
                && node_storage_relative_path(&epoch, &self.source()).is_ok(),
            "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
        );
        let epoch = node_storage_relative_path(&epoch, &self.component.source)?;
        let epoch_root = directory(&self.component_root, &epoch)?.context(INVALID)?;
        check_node_identity(&epoch_root, &value["identities"]["epochDirectory"])?;
        // The Relay owner verifies the original format's reference under its
        // live handles. Native compares only the complete transient handle proof.
        let parent = directory(
            &self.component_root,
            &node_storage_relative_path(
                projection.parent().context(INVALID)?,
                &self.component.source,
            )?,
        )?
        .context(INVALID)?;
        let projection_file =
            match parent.open_regular_file(projection.file_name().context(INVALID)?) {
                Ok(file) => {
                    ensure!(
                        matches_node_path(&value["paths"]["projection"], &projection),
                        "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
                    );
                    check_node_file(&file, &value["identities"]["projection"])?;
                    Some(file)
                }
                Err(error) if missing(&error) => {
                    ensure!(
                        value["paths"]["projection"].is_null(),
                        "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
                    );
                    None
                }
                Err(error) => return Err(error),
            };
        let marker_file = epoch_root.open_regular_file(OsStr::new("marker.json"))?;
        if let Some(shared) = entry["sharedIdentityFile"].as_str() {
            let shared = Path::new(entry["source"].as_str().context(INVALID)?).join(shared);
            ensure!(
                matches_node_path(&value["sharedIdentityFile"], &shared),
                "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
            );
            let shared = node_storage_relative_path(&shared, &self.component.source)?;
            let canonical = self
                .relays
                .iter()
                .find(|relay| relay.projection == shared)
                .context(INVALID)?;
            ensure!(
                canonical.epoch_root.directory_identity()? == epoch_root.directory_identity()?,
                "STORAGE_GATEWAY_RELAY_DUAL_IDENTITY_UNSUPPORTED"
            );
        } else {
            ensure!(
                value["sharedIdentityFile"].is_null(),
                "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
            );
        }
        let receipt_path = PathBuf::from(format!("{}.relocation-v1", projection.display()));
        let receipt_relative = node_storage_relative_path(&receipt_path, &self.component.source)?;
        let receipt_root = directory(&self.component_root, &receipt_relative)?;
        let receipt = match receipt_root {
            None => {
                ensure!(
                    value["paths"]["transferReceiptDirectory"].is_null()
                        && value["paths"]["transferReceiptFile"].is_null()
                        && value["transferReceipt"].is_null(),
                    "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
                );
                None
            }
            Some(root) => {
                ensure!(
                    matches_node_path(&value["paths"]["transferReceiptDirectory"], &receipt_path)
                        && matches_node_path(
                            &value["paths"]["transferReceiptFile"],
                            &receipt_path.join("reference.json")
                        )
                        && read_json(&root, "reference.json")? == value["transferReceipt"],
                    "STORAGE_GATEWAY_RELAY_REFERENCE_INVALID"
                );
                check_node_identity(&root, &value["identities"]["transferReceiptDirectory"])?;
                let file = root.open_single_link_regular_file(OsStr::new("reference.json"))?;
                check_node_file(&file, &value["identities"]["transferReceiptFile"])?;
                Some(RelayTransferReceipt {
                    path: receipt_relative.to_owned(),
                    root,
                    file,
                    value: value["transferReceipt"].clone(),
                })
            }
        };
        let projection = node_storage_relative_path(&projection, &self.component.source)?;
        self.exclusions.extend([reference.clone(), epoch.clone()]);
        if projection_file.is_some() {
            self.exclusions.insert(projection.clone());
        }
        if let Some(receipt) = &receipt {
            self.exclusions.insert(receipt.path.clone());
        }
        self.relays.push(RelayTransfer {
            projection,
            projection_file,
            marker_file,
            reference,
            reference_root,
            reference_file,
            reference_value: original,
            epoch,
            epoch_root,
            receipt,
        });
        Ok(())
    }
}

fn check_node_identity(directory: &PrivateDirectory, expected: &Value) -> Result<()> {
    ensure!(
        expected.as_object().is_some_and(|fields| fields.len() == 2
            && fields.contains_key("identity")
            && fields.contains_key("links"))
            && expected["identity"]
                == serde_json::to_string(&directory.portable_directory_handle_identity()?)?
            && expected["links"].is_null(),
        "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
    );
    Ok(())
}

fn check_node_file(file: &File, expected: &Value) -> Result<()> {
    let (identity, links) = observed_file(file)?;
    ensure!(
        expected.as_object().is_some_and(|fields| fields.len() == 2
            && fields.contains_key("identity")
            && fields.contains_key("links"))
            && expected["identity"] == identity
            && expected["links"] == links.to_string(),
        "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
    );
    Ok(())
}
fn allowed_facts(entries: &[Value], id: &str, phase: &str) -> Result<Vec<Value>> {
    let mut allowed = Vec::new();
    for entry in entries {
        let domain = match entry["kind"].as_str().expect("parent-declared owner") {
            "mobile" => "gateway-device-pairing",
            "channels" => "gateway-channels",
            "relay" => "gateway-relay",
            "productAccountCookieScope" => "gateway-product-account-cookie-scope",
            _ => unreachable!("sealed owners use their original Native relocation object"),
        };
        let facts = json!({"domain":domain,"operationId":id,"source":entry["source"],"finalTarget":entry["finalTarget"]});
        allowed.push(facts.clone());
        if entry["kind"] == "productAccountCookieScope" {
            let mut facts = facts;
            facts["purpose"] = json!(if phase == "prepareSource" {
                "productAccountScopeSource"
            } else {
                "productAccountScopePublished"
            });
            allowed.push(facts);
        } else if entry["kind"] == "relay" {
            let name = entry["sourceIdentityFile"]
                .as_str()
                .expect("declared Relay path");
            let source = Path::new(entry["source"].as_str().expect("declared source")).join(name);
            let target = if phase == "prepareSource" {
                source.clone()
            } else {
                Path::new(
                    entry["finalTarget"]
                        .as_str()
                        .expect("declared final target"),
                )
                .join(name)
            };
            allowed.push(json!({"domain":if phase == "prepareSource" {"gateway-relay-identity-source"} else {"gateway-relay-identity"},
                "operationId":id,"source":node_storage_path(&source)?,"finalTarget":node_storage_path(&target)?}));
        }
    }
    Ok(allowed)
}
fn validate_result(value: &Value, entries: &[Value], id: &str, phase: &str) -> Result<()> {
    ensure!(
        value["version"] == 1 && value["operationId"] == id && value["phase"] == phase,
        INVALID
    );
    let results = value["domains"]
        .as_array()
        .filter(|results| results.len() == entries.len())
        .context(INVALID)?;
    for (entry, result) in entries.iter().zip(results) {
        ensure!(
            result["kind"] == entry["kind"]
                && result["source"] == entry["source"]
                && result["finalTarget"] == entry["finalTarget"]
                && result["state"]
                    == if phase == "prepareSource"
                        && matches!(entry["kind"].as_str(), Some("mobile" | "channels"))
                    {
                        "observed"
                    } else {
                        "prepared"
                    },
            INVALID
        );
    }
    Ok(())
}
async fn run(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: &mut Command,
    entries: &[Value],
    phase: &str,
    mut relay_source: Option<&mut GatewayDomainsSource>,
    channel_reads: &[&ChannelRead],
) -> Result<Value> {
    let allowed = allowed_facts(entries, id, phase)?;
    // The existing pump freshly verifies the one stopped coordinator on every
    // frame. This callback only restricts the owner's original domain and paths.
    let result = run_offline_owner_child(
        coordinator,
        id,
        command,
        json!({"version":1,"phase":phase,"domains":entries}),
        TIMEOUT,
        |facts| {
            if let Some(source) = relay_source.as_ref()
                && let Some(channels) = &source.channels
            {
                channels.verify()?;
            }
            for channels in channel_reads {
                channels.verify()?;
            }
            let mut scope = facts.clone();
            let proof = scope
                .as_object_mut()
                .and_then(|value| value.remove("sourceProof"));
            ensure!(allowed.contains(&scope), "STORAGE_OFFLINE_DOMAIN_MISMATCH");
            if let Some(proof) = proof {
                ensure!(
                    phase == "prepareSource" && scope["domain"] == "gateway-relay",
                    INVALID
                );
                let identity = proof["identityFile"].as_str().context(INVALID)?;
                let entry = entries
                    .iter()
                    .find(|entry| {
                        entry["kind"] == "relay"
                            && entry["source"] == scope["source"]
                            && entry["finalTarget"] == scope["finalTarget"]
                            && entry["source"]
                                .as_str()
                                .zip(entry["sourceIdentityFile"].as_str())
                                .is_some_and(|(root, name)| {
                                    Path::new(root).join(name) == Path::new(identity)
                                })
                    })
                    .context(INVALID)?;
                let source = relay_source.as_deref_mut().context(INVALID)?;
                if let Some(previous) = source.prepared_relay_values.get(identity) {
                    ensure!(*previous == proof, "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED");
                } else {
                    // The child still owns its Native metadata descriptors. Hold
                    // matching parent descriptors before acknowledging this frame.
                    source.freeze_relay(entry, &proof)?;
                    source.prepared_relay_values.insert(identity.into(), proof);
                }
            }
            Ok(())
        },
    )
    .await?;
    validate_result(&result, entries, id, phase)?;
    Ok(result)
}
pub(super) fn preview_gateway_domains(receipt: &StorageMigrationReceipt) -> Result<bool> {
    let mut source = GatewayDomainsSource::observe(&receipt.plan)?;
    source.discover()?;
    internal_references::check(&receipt.plan, &source)?;
    Ok(!source.entries.is_empty())
}
pub(super) async fn prepare_gateway_domains(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: Option<&mut Command>,
) -> Result<GatewayDomainsSource> {
    let receipt = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?;
    ensure!(
        receipt.plan.operation_id == id,
        "STORAGE_OPERATION_CONFLICT"
    );
    let fences = coordinator.prepare_offline_child_fences(id)?;
    let mut source = GatewayDomainsSource::observe(&receipt.plan)?;
    if let Some(gateway) = &source.gateway {
        ensure!(
            fences
                .roots
                .iter()
                .any(|fence| fence.root == source.source()
                    && gateway.directory_identity().ok().as_ref()
                        == Some(&fence.directory_identity)),
            "STORAGE_GATEWAY_SOURCE_LEASE_REQUIRED"
        );
    }
    source.discover()?;
    internal_references::check(&receipt.plan, &source)?;
    if source.entries.is_empty() {
        source.verify(coordinator, id)?;
        return Ok(source);
    }
    let command = command.context("STORAGE_OWNER_RUNTIME_REQUIRED")?;
    if let Some(entry) = source
        .entries
        .iter_mut()
        .find(|entry| entry["kind"] == "channels")
    {
        let original = Path::new(entry["source"].as_str().context(INVALID)?);
        let channels = ChannelRead::prepare(coordinator, id, original)?;
        entry["sourceReadDirectory"] = json!(node_storage_path(channels.path())?);
        source.channels = Some(channels);
    }
    let entries = source.entries.clone();
    let result = run(
        coordinator,
        id,
        command,
        &entries,
        "prepareSource",
        Some(&mut source),
        &[],
    )
    .await?;
    for (entry, result) in source
        .entries
        .clone()
        .iter()
        .zip(result["domains"].as_array().expect("validated results"))
    {
        if entry["kind"] == "relay" {
            let value = &result["value"];
            let identity = value["identityFile"].as_str().context(INVALID)?;
            ensure!(
                source.prepared_relay_values.get(identity) == Some(value),
                "STORAGE_GATEWAY_RELAY_SOURCE_CHANGED"
            );
        }
    }
    source.verify(coordinator, id)?;
    Ok(source)
}
async fn run_published(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: Option<&mut Command>,
    source: &GatewayDomainsSource,
    published: &StoragePublishedComponent,
    phase: &str,
) -> Result<()> {
    source.verify(coordinator, id)?;
    source.published(id, published)?;
    if !source.entries.is_empty() {
        let mut entries = source.entries.clone();
        let target_channels =
            if let Some(entry) = entries.iter_mut().find(|entry| entry["kind"] == "channels") {
                let target = Path::new(entry["finalTarget"].as_str().context(INVALID)?);
                let channels = ChannelRead::prepare(coordinator, id, target)?;
                entry["targetReadDirectory"] = json!(node_storage_path(channels.path())?);
                Some(channels)
            } else {
                None
            };
        let channel_reads = source
            .channels
            .iter()
            .chain(target_channels.iter())
            .collect::<Vec<_>>();
        run(
            coordinator,
            id,
            command.context("STORAGE_OWNER_RUNTIME_REQUIRED")?,
            &entries,
            phase,
            None,
            &channel_reads,
        )
        .await?;
        if let Some(channels) = &target_channels {
            channels.verify()?;
        }
    }
    source.verify(coordinator, id)?;
    source.published(id, published)?;
    Ok(())
}
pub(super) async fn relocate_gateway_domains(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: Option<&mut Command>,
    source: &GatewayDomainsSource,
    published: &StoragePublishedComponent,
) -> Result<()> {
    run_published(coordinator, id, command, source, published, "relocate").await
}
pub(super) async fn verify_gateway_domains(
    coordinator: &mut StorageCoordinator,
    id: &str,
    command: Option<&mut Command>,
    source: &GatewayDomainsSource,
    published: &StoragePublishedComponent,
) -> Result<()> {
    run_published(coordinator, id, command, source, published, "verify").await
}

#[cfg(all(test, unix))]
#[path = "storage_gateway_domains_tests.rs"]
mod tests;
