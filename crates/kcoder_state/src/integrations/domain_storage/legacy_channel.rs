//! Consent-gated detection and removal of retired channel domain storage.
//!
//! Older installs created owner-bound domain directories for channel bots,
//! events, chat bindings, credentials and secret contexts. Current code never
//! opens them except as a task-workspace invalidation fence, so they can only be
//! removed through this explicit, user-invoked path. Detection reads the domain
//! control marker (owner/domain labels only) and entry metadata; it never reads
//! or returns the contents of files inside the legacy directories.
use super::{Initialization, StorageDomain, names, read_control_bytes};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, PrivateLeaseMode};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::Path,
};

/// Retired domains. Their persisted serde names stay stable because the
/// namespace hash input includes the serialized domain label.
pub const LEGACY_CHANNEL_DOMAINS: [StorageDomain; 5] = [
    StorageDomain::ConnectivityBots,
    StorageDomain::ConnectivityEvents,
    StorageDomain::ConnectivityChatBindings,
    StorageDomain::ConnectivityCredentials,
    StorageDomain::ConnectivitySecretContexts,
];

/// Persisted labels of [`LEGACY_CHANNEL_DOMAINS`], in the same order.
pub const LEGACY_CHANNEL_DOMAIN_NAMES: [&str; 5] = [
    "connectivity_bots",
    "connectivity_events",
    "connectivity_chat_bindings",
    "connectivity_credentials",
    "connectivity_secret_contexts",
];

/// A directory renamed out of its live namespace name before recursive removal.
/// A crash leaves it under this prefix; the next explicit cleanup removes it.
pub const LEGACY_CHANNEL_TRASH_PREFIX: &str = ".kcoder-legacy-channel-trash-";

const MAX_PROFILE_ENTRIES: usize = 8192;
const MAX_REPORTED_CHILDREN: usize = 65_536;

impl StorageDomain {
    /// True for retired channel domains that only the explicit cleanup may remove.
    pub fn is_legacy_channel(self) -> bool {
        LEGACY_CHANNEL_DOMAINS.contains(&self)
    }

    /// Stable persisted label (the serde name used in the namespace hash).
    pub fn persisted_name(self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyChannelDataStatus {
    /// Marker and directory present; removable after consent.
    Present,
    /// Marker present without its directory (interrupted initialization or cleanup).
    MarkerOnly,
    /// A renamed trash directory left by an interrupted cleanup.
    InterruptedCleanup,
    /// Not removable: unsafe entry type, changed identity, or active lease.
    Refused(&'static str),
}

/// Names, counts and sizes only. No file contents are ever captured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyChannelDataEntry {
    /// `None` only for an orphaned trash directory whose marker is already gone.
    pub domain: Option<StorageDomain>,
    /// The hashed namespace directory name (`integration-<sha256>`) or trash name.
    pub namespace_id: String,
    pub status: LegacyChannelDataStatus,
    /// Direct children of the directory (not recursive).
    pub top_level_entries: usize,
    /// Sum of direct regular-file children lengths.
    pub top_level_bytes: u64,
    marker_name: Option<OsString>,
    trash_name: OsString,
}

impl LegacyChannelDataEntry {
    pub fn domain_label(&self) -> String {
        self.domain
            .map(StorageDomain::persisted_name)
            .unwrap_or_else(|| "unknown".into())
    }

    pub fn removable(&self) -> bool {
        !matches!(self.status, LegacyChannelDataStatus::Refused(_))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyChannelDataReport {
    pub entries: Vec<LegacyChannelDataEntry>,
}

impl LegacyChannelDataReport {
    pub fn removable(&self) -> impl Iterator<Item = &LegacyChannelDataEntry> {
        self.entries.iter().filter(|entry| entry.removable())
    }

    pub fn refused(&self) -> impl Iterator<Item = &LegacyChannelDataEntry> {
        self.entries.iter().filter(|entry| !entry.removable())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyChannelCleanup {
    pub removed: Vec<LegacyChannelDataEntry>,
    pub refused: Vec<LegacyChannelDataEntry>,
}

/// Read-only detection under the profile directory. A missing profile reports nothing.
pub fn detect_legacy_channel_data(profile_path: &Path) -> Result<LegacyChannelDataReport> {
    let Some(profile) = open_profile(profile_path)? else {
        return Ok(LegacyChannelDataReport::default());
    };
    detect_in(&profile)
}

/// Remove only legacy channel domains after the caller obtained explicit consent.
/// Never called automatically. Refused entries are reported and left untouched.
pub fn clean_legacy_channel_data(profile_path: &Path) -> Result<LegacyChannelCleanup> {
    let Some(profile) = open_profile(profile_path)? else {
        return Ok(LegacyChannelCleanup::default());
    };
    let report = detect_in(&profile)?;
    let mut result = LegacyChannelCleanup::default();
    for entry in report.entries {
        if !entry.removable() {
            result.refused.push(entry);
            continue;
        }
        match remove_entry(&profile, &entry) {
            Ok(()) => result.removed.push(entry),
            Err(reason) => result.refused.push(LegacyChannelDataEntry {
                status: LegacyChannelDataStatus::Refused(reason),
                ..entry
            }),
        }
    }
    profile.verify_private_directory()?;
    Ok(result)
}

fn open_profile(profile_path: &Path) -> Result<Option<PrivateDirectory>> {
    match std::fs::symlink_metadata(profile_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) => ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "LEGACY_CHANNEL_PROFILE_NOT_DIRECTORY"
        ),
    }
    let profile = PrivateDirectory::open_existing(profile_path)?;
    profile
        .verify_private_directory()
        .context("LEGACY_CHANNEL_PROFILE_CHANGED")?;
    Ok(Some(profile))
}

fn detect_in(profile: &PrivateDirectory) -> Result<LegacyChannelDataReport> {
    let names = profile.entry_names_bounded(MAX_PROFILE_ENTRIES + 1)?;
    ensure!(
        names.len() <= MAX_PROFILE_ENTRIES,
        "LEGACY_CHANNEL_PROFILE_CAPACITY"
    );
    let mut markers = BTreeMap::new();
    let mut trash = BTreeMap::new();
    for name in names {
        let Some(text) = name.to_str() else { continue };
        if let Some(digest) = text
            .strip_prefix(".integration-")
            .and_then(|value| value.strip_suffix(".jsonl"))
            .filter(|digest| is_digest(digest))
        {
            markers.insert(digest.to_owned(), name.clone());
        } else if let Some(digest) = text
            .strip_prefix(LEGACY_CHANNEL_TRASH_PREFIX)
            .filter(|digest| is_digest(digest))
        {
            trash.insert(digest.to_owned(), name.clone());
        }
    }
    let mut entries = Vec::new();
    for (digest, marker) in markers {
        let Some(domain) = legacy_marker_domain(profile, &marker, &digest) else {
            continue;
        };
        let directory_name = OsString::from(format!("integration-{digest}"));
        let trash_name = trash
            .remove(&digest)
            .unwrap_or_else(|| OsString::from(format!("{LEGACY_CHANNEL_TRASH_PREFIX}{digest}")));
        let mut entry = LegacyChannelDataEntry {
            domain: Some(domain),
            namespace_id: directory_name.to_string_lossy().into_owned(),
            status: LegacyChannelDataStatus::MarkerOnly,
            top_level_entries: 0,
            top_level_bytes: 0,
            marker_name: Some(marker),
            trash_name,
        };
        match inspect_directory(profile, &directory_name) {
            Inspection::Missing => {}
            Inspection::Directory(count, bytes) => {
                entry.status = LegacyChannelDataStatus::Present;
                entry.top_level_entries = count;
                entry.top_level_bytes = bytes;
            }
            Inspection::Refused(reason) => {
                entry.status = LegacyChannelDataStatus::Refused(reason);
            }
        }
        if matches!(entry.status, LegacyChannelDataStatus::MarkerOnly) {
            match inspect_directory(profile, &entry.trash_name) {
                Inspection::Missing => {}
                Inspection::Directory(count, bytes) => {
                    entry.status = LegacyChannelDataStatus::InterruptedCleanup;
                    entry.top_level_entries = count;
                    entry.top_level_bytes = bytes;
                }
                Inspection::Refused(reason) => {
                    entry.status = LegacyChannelDataStatus::Refused(reason);
                }
            }
        }
        entries.push(entry);
    }
    for (_, name) in trash {
        let mut entry = LegacyChannelDataEntry {
            domain: None,
            namespace_id: name.to_string_lossy().into_owned(),
            status: LegacyChannelDataStatus::InterruptedCleanup,
            top_level_entries: 0,
            top_level_bytes: 0,
            marker_name: None,
            trash_name: name.clone(),
        };
        match inspect_directory(profile, &name) {
            Inspection::Missing => continue,
            Inspection::Directory(count, bytes) => {
                entry.top_level_entries = count;
                entry.top_level_bytes = bytes;
            }
            Inspection::Refused(reason) => entry.status = LegacyChannelDataStatus::Refused(reason),
        }
        entries.push(entry);
    }
    Ok(LegacyChannelDataReport { entries })
}

/// Returns the legacy domain only for a single-link regular marker whose
/// persisted owner/domain hash reproduces its own name. Contents are not retained.
fn legacy_marker_domain(
    profile: &PrivateDirectory,
    marker: &OsStr,
    digest: &str,
) -> Option<StorageDomain> {
    let file = profile.open_single_link_regular_file(marker).ok()?;
    legacy_marker_domain_from(&file, digest)
}

fn legacy_marker_domain_from(file: &std::fs::File, digest: &str) -> Option<StorageDomain> {
    let control = read_control_bytes(file).ok()?;
    let first = control.split(|byte| *byte == b'\n').next()?;
    let initialization: Initialization = serde_json::from_slice(first).ok()?;
    if !initialization.domain.is_legacy_channel() {
        return None;
    }
    let (marker_name, directory_name) = names(&initialization.owner, initialization.domain).ok()?;
    (marker_name == format!(".integration-{digest}.jsonl")
        && directory_name == initialization.directory_name)
        .then_some(initialization.domain)
}

enum Inspection {
    Missing,
    Directory(usize, u64),
    Refused(&'static str),
}

fn inspect_directory(profile: &PrivateDirectory, name: &OsStr) -> Inspection {
    let entry = match profile.open_entry_handle(name) {
        Ok(entry) => entry,
        Err(error) if missing(&error) => return Inspection::Missing,
        Err(_) => return Inspection::Refused("LEGACY_CHANNEL_ENTRY_UNSAFE"),
    };
    let metadata = entry.metadata();
    if metadata.file_type().is_symlink() || !metadata.is_dir() || reparse_point(metadata) {
        return Inspection::Refused("LEGACY_CHANNEL_ENTRY_NOT_DIRECTORY");
    }
    let Ok(directory) = entry.open_child_directory() else {
        return Inspection::Refused("LEGACY_CHANNEL_ENTRY_CHANGED");
    };
    if directory.verify_private_directory().is_err() {
        return Inspection::Refused("LEGACY_CHANNEL_ENTRY_CHANGED");
    }
    let Ok(children) = directory.entry_names_bounded(MAX_REPORTED_CHILDREN) else {
        return Inspection::Refused("LEGACY_CHANNEL_ENTRY_UNREADABLE");
    };
    let bytes = children
        .iter()
        .filter_map(|child| directory.entry_metadata(child).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum();
    Inspection::Directory(children.len(), bytes)
}

/// Remove one detected entry. Every precondition is re-checked under the
/// domain's exclusive marker lease, so an active reader or initializer wins.
fn remove_entry(
    profile: &PrivateDirectory,
    entry: &LegacyChannelDataEntry,
) -> std::result::Result<(), &'static str> {
    let Some(marker) = &entry.marker_name else {
        // Orphaned trash: no live namespace name refers to it any more.
        return remove_trash(profile, &entry.trash_name);
    };
    // This path reports fixed `&'static str` codes and has no logging sink in
    // every crate that compiles it, so filesystem sources are not retained.
    let file = profile
        .open_single_link_regular_file(marker)
        .map_err(|_| "LEGACY_CHANNEL_MARKER_CHANGED")?;
    let identity = profile
        .portable_regular_handle_identity(&file)
        .map_err(|_| "LEGACY_CHANNEL_MARKER_CHANGED")?;
    let lease = profile
        .try_existing_portable_lock(marker, &identity, PrivateLeaseMode::Exclusive)
        .map_err(|_| "LEGACY_CHANNEL_MARKER_CHANGED")?
        .ok_or("LEGACY_CHANNEL_DATA_BUSY")?;
    let digest = entry
        .namespace_id
        .strip_prefix("integration-")
        .ok_or("LEGACY_CHANNEL_MARKER_CHANGED")?;
    // A separate read handle cannot access the lease's locked bytes on Windows.
    if legacy_marker_domain_from(lease.file(), digest) != entry.domain {
        return Err("LEGACY_CHANNEL_MARKER_CHANGED");
    }
    let directory_name = OsString::from(&entry.namespace_id);
    match inspect_directory(profile, &directory_name) {
        Inspection::Missing => {}
        Inspection::Refused(reason) => return Err(reason),
        Inspection::Directory(..) => {
            // Leave a previous interrupted trash first so the no-replace rename succeeds.
            remove_trash(profile, &entry.trash_name)?;
            // Atomic from every observer's view: the live name disappears whole.
            profile
                .rename_no_replace(&directory_name, &entry.trash_name)
                .map_err(|_| "LEGACY_CHANNEL_RENAME_FAILED")?;
        }
    }
    remove_trash(profile, &entry.trash_name)?;
    // The marker is removed last; until then a crash leaves a detectable entry.
    let current = profile
        .open_single_link_regular_file(marker)
        .and_then(|current| profile.portable_regular_handle_identity(&current))
        .map_err(|_| "LEGACY_CHANNEL_MARKER_CHANGED")?;
    if current != identity {
        return Err("LEGACY_CHANNEL_MARKER_CHANGED");
    }
    #[cfg(windows)]
    let removed = {
        drop(lease);
        profile.remove_regular_file_if_handle(marker, &file)
    };
    #[cfg(not(windows))]
    let removed = {
        let removed = profile.remove_regular_file(marker);
        drop(lease);
        removed
    };
    removed.map_err(|_| "LEGACY_CHANNEL_MARKER_REMOVE_FAILED")
}

fn remove_trash(profile: &PrivateDirectory, name: &OsStr) -> std::result::Result<(), &'static str> {
    match inspect_directory(profile, name) {
        Inspection::Missing => Ok(()),
        Inspection::Refused(reason) => Err(reason),
        // Removal is relative to the held profile handle and never follows links.
        Inspection::Directory(..) => profile
            .remove_child_entry(name, true)
            .map_err(|_| "LEGACY_CHANNEL_REMOVE_FAILED"),
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(windows)]
fn reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn reparse_point(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
#[path = "legacy_channel_tests.rs"]
mod tests;
