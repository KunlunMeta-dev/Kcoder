//! Current source observations and routing for legacy client namespaces.
//! These held-interval facts are not persistent business identity mappings.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    storage::{StorageTreeEntryKind as Kind, StorageTreeInventory},
};
use kcoder_types::StorageMigrationPlan;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rules {
    version: u32,
    gateway_files: Vec<String>,
    gateway_directories: Vec<String>,
    desktop_files: Vec<String>,
    desktop_directories: Vec<String>,
    controls: Vec<String>,
    desktop_controls: Vec<String>,
    partition: String,
    gateway_backup_pattern: String,
}

fn same(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

impl Rules {
    fn read() -> Result<Self> {
        let rules: Self = serde_json::from_str(include_str!(
            "../../../../apps/kcoder-studio/src/migrations/legacy-owner-namespaces.json"
        ))?;
        ensure!(rules.version == 1, "STORAGE_LEGACY_RULES_INVALID");
        Ok(rules)
    }

    fn contains(names: &[String], name: &str) -> bool {
        names.iter().any(|candidate| same(candidate, name))
    }

    fn backup(&self, name: &str) -> Result<bool> {
        // The shared descriptor has one fixed backup format, not arbitrary
        // executable rules or a second routing language.
        let (prefix, suffix) = self
            .gateway_backup_pattern
            .split_once("[12]-[a-f0-9]{64}")
            .context("STORAGE_LEGACY_RULES_INVALID")?;
        let prefix = prefix
            .strip_prefix('^')
            .context("STORAGE_LEGACY_RULES_INVALID")?
            .replace(r"\.", ".");
        let suffix = suffix
            .strip_suffix('$')
            .context("STORAGE_LEGACY_RULES_INVALID")?
            .replace(r"\.", ".");
        let Some(body) = name
            .strip_prefix(&prefix)
            .and_then(|body| body.strip_suffix(&suffix))
        else {
            return Ok(false);
        };
        Ok(body.len() == 66
            && matches!(body.as_bytes()[0], b'1' | b'2')
            && body.as_bytes()[1] == b'-'
            && body.as_bytes()[2..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)))
    }
}

struct Entry {
    path: PathBuf,
    identity: String,
    kind: Kind,
    owner: &'static str,
    recursive: bool,
}

pub(super) struct LegacyClientSource {
    pub(super) root: PrivateDirectory,
    roles: BTreeSet<String>,
    entries: Vec<Entry>,
}

fn names(root: &PrivateDirectory) -> Result<Vec<std::ffi::OsString>> {
    let mut names = Vec::new();
    root.visit_entry_names_bounded(2048, |name| {
        names.push(name.to_owned());
        Ok(())
    })?;
    names.sort();
    Ok(names)
}

fn observe_entry(
    root: &PrivateDirectory,
    name: &OsStr,
    path: PathBuf,
    owner: &'static str,
    recursive: bool,
    expected: Option<Kind>,
) -> Result<Entry> {
    let entry = root.open_entry_handle(name)?;
    let metadata = entry.metadata();
    let kind = if metadata.is_file() {
        Kind::RegularFile
    } else if metadata.is_dir() {
        Kind::Directory
    } else if metadata.file_type().is_symlink() {
        Kind::Symlink
    } else {
        anyhow::bail!("STORAGE_LEGACY_ENTRY_KIND_UNSUPPORTED")
    };
    ensure!(
        expected.is_none_or(|expected| kind == expected),
        "STORAGE_LEGACY_ENTRY_KIND_MISMATCH"
    );
    if owner == "control" {
        ensure!(
            metadata.len() == 0,
            "STORAGE_LEGACY_CONTROL_PAYLOAD_UNCONFIRMED"
        );
    }
    Ok(Entry {
        path,
        identity: entry.identity()?,
        kind,
        owner,
        recursive,
    })
}

fn gateway_payload_identity(
    path: &Path,
    shared_desktop: bool,
    rules: &Rules,
) -> Result<Option<String>> {
    let root = match PrivateDirectory::open_existing(path) {
        Ok(root) => root,
        Err(error) if super::missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    for name in names(&root)? {
        let text = name
            .to_str()
            .context("STORAGE_LEGACY_ENTRY_NAME_UNSUPPORTED")?;
        if Rules::contains(&rules.controls, text) {
            let entry = root.open_entry_handle(&name)?;
            if entry.metadata().is_file() && entry.metadata().len() == 0 {
                continue;
            }
        }
        // The standalone root belongs entirely to Gateway; unknown leaves there
        // must still reach admission and cannot be hidden by an empty-root guess.
        if !shared_desktop
            || Rules::contains(&rules.gateway_files, text)
            || Rules::contains(&rules.gateway_directories, text)
            || rules.backup(text)?
        {
            return root.directory_identity().map(Some);
        }
    }
    Ok(None)
}

/// All entry points converge on the one populated, declared legacy Gateway.
/// A valid registration is handled separately and remains authoritative.
pub(super) fn select_unregistered_gateway(
    home: &Path,
    paths: &mut kcoder_types::StoragePaths,
) -> Result<()> {
    let standalone = home.join(".config/kcoder-studio");
    if standalone == paths.desktop_root {
        return Ok(());
    }
    let rules = Rules::read()?;
    let standalone_identity = gateway_payload_identity(&standalone, false, &rules)?;
    let desktop_identity = gateway_payload_identity(&paths.desktop_root, true, &rules)?;
    ensure!(
        standalone_identity.is_none()
            || desktop_identity.is_none()
            || standalone_identity == desktop_identity,
        "STORAGE_LEGACY_SOURCE_CONFLICT"
    );
    if desktop_identity.is_some() {
        paths.gateway_root = paths.desktop_root.clone();
    } else if standalone_identity.is_some() {
        paths.gateway_root = standalone;
    }
    Ok(())
}

/// Read each physical source once, allowing only explicitly declared owners.
pub(super) fn observe(
    plan: &StorageMigrationPlan,
    controls: &BTreeSet<String>,
    preview: bool,
    registration: Option<&super::registered::RegisteredSources>,
) -> Result<Vec<LegacyClientSource>> {
    let rules = Rules::read()?;
    let (partition_parent, partition_name) = rules
        .partition
        .split_once('/')
        .context("STORAGE_LEGACY_RULES_INVALID")?;
    let native_identity =
        PrivateDirectory::open_existing(&plan.from.data_root)?.directory_identity()?;
    let separate_registered_gateway = registration
        .and_then(|source| source.gateway.as_ref())
        .is_some_and(|gateway| {
            gateway == &plan.from.gateway_root && gateway != &plan.from.desktop_root
        });
    let mut sources = BTreeMap::<String, LegacyClientSource>::new();
    for component in plan
        .components
        .iter()
        .filter(|component| matches!(component.domain.as_str(), "gateway" | "desktop"))
    {
        let root = PrivateDirectory::open_existing(&component.source)?;
        let identity = root.directory_identity()?;
        ensure!(
            identity == component.source_identity && identity != native_identity,
            "STORAGE_LEGACY_SOURCE_CHANGED"
        );
        sources
            .entry(identity)
            .or_insert_with(|| LegacyClientSource {
                root,
                roles: BTreeSet::new(),
                entries: Vec::new(),
            })
            .roles
            .insert(component.domain.clone());
    }
    for source in sources.values_mut() {
        for name in names(&source.root)? {
            let entry = source.root.open_entry_handle(&name)?;
            if entry.metadata().is_file() && controls.contains(&entry.identity()?) {
                continue;
            }
            let text = name
                .to_str()
                .context("STORAGE_LEGACY_ENTRY_NAME_UNSUPPORTED")?;
            let path = PathBuf::from(&name);
            let (owner, kind, recursive) = if Rules::contains(&rules.controls, text) {
                ("control", Kind::RegularFile, false)
            } else if Rules::contains(&rules.gateway_files, text) || rules.backup(text)? {
                ("gateway", Kind::RegularFile, false)
            } else if Rules::contains(&rules.gateway_directories, text) {
                ("gateway", Kind::Directory, true)
            } else if Rules::contains(&rules.desktop_files, text) {
                ("desktop", Kind::RegularFile, false)
            } else if Rules::contains(&rules.desktop_directories, text) {
                ("desktop", Kind::Directory, true)
            } else if same(partition_parent, text) {
                ("desktop", Kind::Directory, false)
            } else if preview
                && source.roles.contains("desktop")
                && Rules::contains(&rules.desktop_controls, text)
            {
                // A preview observes a live SDK. Stopped copying never omits
                // remaining Singleton leaves under this observation.
                source.entries.push(observe_entry(
                    &source.root,
                    &name,
                    path,
                    "desktop",
                    false,
                    None,
                )?);
                continue;
            } else {
                // Runtime controls must disappear at shutdown, even when they
                // happen to be ordinary files rather than SDK links.
                ensure!(
                    !Rules::contains(&rules.desktop_controls, text),
                    "STORAGE_LEGACY_DESKTOP_CONTROL_PRESENT"
                );
                // Preserve unrecognized payloads in their source namespace.
                // Mixed userData belongs to Desktop unless a known rule says
                // Gateway; arbitrary backups never become active settings.
                let kind = if entry.metadata().is_dir() {
                    Kind::Directory
                } else {
                    Kind::RegularFile
                };
                (
                    if source.roles.contains("desktop") {
                        "desktop"
                    } else {
                        "gateway"
                    },
                    kind,
                    kind == Kind::Directory,
                )
            };
            // An existing startup registration can select a separate Gateway
            // while Electron's old userData still holds its previous records.
            // Retain those leaves in the source; never merge or reactivate them
            // under the selected Gateway, or copy them as active Desktop state.
            let owner = if owner == "gateway"
                && source.roles.contains("desktop")
                && !source.roles.contains("gateway")
                && separate_registered_gateway
            {
                "retained-gateway"
            } else {
                owner
            };
            ensure!(
                owner == "control" || owner == "retained-gateway" || source.roles.contains(owner),
                "STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED"
            );
            source.entries.push(observe_entry(
                &source.root,
                &name,
                path.clone(),
                owner,
                recursive,
                Some(kind),
            )?);
            if same(partition_parent, text) {
                let partitions = source.root.open_child(&name, false)?;
                for child in names(&partitions)? {
                    let held = partitions.open_entry_handle(&child)?;
                    if held.metadata().is_file() && controls.contains(&held.identity()?) {
                        continue;
                    }
                    let kind = if held.metadata().is_dir()
                        || child
                            .to_str()
                            .is_some_and(|name| same(name, partition_name))
                    {
                        Kind::Directory
                    } else {
                        Kind::RegularFile
                    };
                    source.entries.push(observe_entry(
                        &partitions,
                        &child,
                        path.join(&child),
                        "desktop",
                        kind == Kind::Directory,
                        Some(kind),
                    )?);
                }
            }
            ensure!(
                source.entries.len() <= 2048,
                "STORAGE_LEGACY_SOURCE_ENTRY_LIMIT"
            );
        }
    }
    Ok(sources.into_values().collect())
}

impl LegacyClientSource {
    pub(super) fn exclusions(&self, role: &str) -> BTreeSet<PathBuf> {
        self.entries
            .iter()
            .filter(|entry| entry.owner != "control" && entry.owner != role)
            .map(|entry| entry.path.clone())
            .collect()
    }

    pub(super) fn verify_inventory(
        &self,
        inventory: &StorageTreeInventory,
        role: &str,
        controls: &BTreeSet<String>,
    ) -> Result<()> {
        ensure!(
            inventory.root_identity == self.root.directory_identity()?,
            "STORAGE_LEGACY_SOURCE_CHANGED"
        );
        for actual in &inventory.entries {
            if actual.excluded
                && actual.kind == Kind::RegularFile
                && controls.contains(&actual.identity)
            {
                continue;
            }
            let expected = self
                .entries
                .iter()
                .find(|entry| entry.path == actual.relative_path)
                .or_else(|| {
                    self.entries.iter().find(|entry| {
                        entry.recursive && actual.relative_path.starts_with(&entry.path)
                    })
                })
                .context("STORAGE_LEGACY_SOURCE_CHANGED")?;
            ensure!(
                expected.owner != "control" && (expected.owner == role || actual.excluded),
                "STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED"
            );
            if expected.path == actual.relative_path {
                ensure!(
                    actual.identity == expected.identity && actual.kind == expected.kind,
                    "STORAGE_LEGACY_SOURCE_CHANGED"
                );
            }
        }
        for expected in &self.entries {
            if expected.owner == "control"
                || self.entries.iter().any(|parent| {
                    parent.owner != role
                        && parent.path != expected.path
                        && expected.path.starts_with(&parent.path)
                })
            {
                continue;
            }
            ensure!(
                inventory
                    .entries
                    .iter()
                    .any(|actual| actual.relative_path == expected.path),
                "STORAGE_LEGACY_SOURCE_CHANGED"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "storage_legacy_sources_tests.rs"]
mod tests;
