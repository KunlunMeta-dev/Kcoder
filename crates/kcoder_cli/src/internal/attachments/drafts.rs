//! Durable unsent uploads. Parent authority selects the owner; file/OS leases
//! survive transport replacement without granting access from a caller's path.
use super::*;
use kcoder_app_protocol::{
    AttachmentDraftPath, AttachmentDraftRetainParams, AttachmentDraftRetainResult,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;

const MAX_DRAFTS: usize = 32;
const RECORD: &str = "record.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    version: u32,
    owner_scope: String,
    thread_id: String,
    source_path: String,
    filename: String,
    size: u64,
    sha256: String,
    released: bool,
}

pub(super) struct OwnedDraft {
    storage: Arc<std::sync::Mutex<DraftStorage>>,
    pub(super) history_root: PathBuf,
    pub(super) pending_turn: Option<(String, String)>,
    pub(super) source_path: PathBuf,
    size: u64,
    sha256: String,
}
pub(super) struct DraftStorage {
    root: PrivateDirectory,
    entry: String,
    lease: Option<std::fs::File>,
    pub(super) steer_pending: bool,
}
impl DraftStorage {
    pub(super) fn remove(&mut self) -> Result<()> {
        if self.lease.is_some() {
            // The exclusive owner lease protects this record independently of
            // the root transaction. Commit release before contending for cleanup,
            // so the next writer can reclaim it even after this connection exits.
            let directory = match self.root.open_child(OsStr::new(&self.entry), false) {
                Ok(directory) => directory,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    self.lease.take();
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            directory.verify_private_directory()?;
            let mut record = read_record(&directory)?;
            if !record.released {
                record.released = true;
                directory.atomic_replace(OsStr::new(RECORD), &serde_json::to_vec(&record)?)?;
            }
            drop(directory);
            self.lease.take();
        }
        let _transaction = lock(&self.root, "transaction.lock")?;
        let directory = match self.root.open_child(OsStr::new(&self.entry), false) {
            Ok(directory) => directory,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                self.lease.take();
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        anyhow::ensure!(
            read_record(&directory)?.released,
            "draft was replaced after release"
        );
        drop(directory);
        self.root.remove_child_tree(OsStr::new(&self.entry))
    }
}
impl OwnedDraft {
    pub(super) fn is_live(&self) -> bool {
        self.storage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .lease
            .is_some()
    }
    pub(super) fn is_available(&self) -> bool {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        storage.lease.is_some() && !storage.steer_pending
    }
    pub(super) fn reserve_steer(&self) -> Result<Arc<std::sync::Mutex<DraftStorage>>> {
        let mut storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        anyhow::ensure!(
            storage.lease.is_some() && !storage.steer_pending,
            "draft is already reserved by an input"
        );
        storage.steer_pending = true;
        Ok(Arc::clone(&self.storage))
    }
    pub(super) fn open_file(&self) -> Result<std::fs::File> {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        anyhow::ensure!(storage.lease.is_some(), "draft has been released");
        let directory = storage.root.open_child(OsStr::new(&storage.entry), false)?;
        directory.verify_private_directory()?;
        let content = directory.open_child(OsStr::new("content"), false)?;
        content.verify_private_directory()?;
        let file = content.open_single_link_regular_file(
            self.source_path
                .file_name()
                .context("invalid draft filename")?,
        )?;
        anyhow::ensure!(file.metadata()?.len() == self.size, "draft size changed");
        Ok(file)
    }
    pub(super) fn verify_bytes(&self, bytes: &[u8]) -> Result<()> {
        anyhow::ensure!(
            bytes.len() as u64 == self.size && hex_sha256(bytes) == self.sha256,
            "draft bytes changed"
        );
        Ok(())
    }
    pub(super) fn remove(&mut self) -> Result<()> {
        self.storage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove()
    }
}

pub(super) fn read_record(directory: &PrivateDirectory) -> Result<Record> {
    let file = directory.open_single_link_regular_file(OsStr::new(RECORD))?;
    anyhow::ensure!(
        file.metadata()?.len() <= 16_384,
        "draft record exceeds budget"
    );
    let mut bytes = Vec::new();
    file.take(16_385).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 16_384, "draft record exceeds budget");
    let record: Record = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        record.version == 1
            && record.size <= MAX_ATTACHMENT_BYTES as u64
            && record.sha256.len() == 64
            && record.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && record.owner_scope.len() == 64
            && record
                .owner_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && !record.thread_id.is_empty()
            && record.thread_id.len() <= 128
            && !record.thread_id.chars().any(char::is_control)
            && !record.source_path.is_empty()
            && record.source_path.len() <= 4096
            && !record.source_path.chars().any(char::is_control),
        "invalid draft record"
    );
    validate_attachment_filename(&record.filename)?;
    anyhow::ensure!(
        Path::new(&record.source_path).file_name() == Some(OsStr::new(&record.filename)),
        "invalid draft filename binding"
    );
    Ok(record)
}
pub(super) fn record_thread(record: &Record) -> &str {
    &record.thread_id
}
fn lock(directory: &PrivateDirectory, name: &str) -> Result<std::fs::File> {
    let file = match directory.open_read_write_file(OsStr::new(name), true) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
        {
            directory.open_single_link_regular_file(OsStr::new(name))?
        }
        Err(error) => return Err(error),
    };
    file.try_lock_exclusive()
        .context("draft attachment is held by another connection")?;
    Ok(file)
}

/// Retain or recover on the same authoritative entry. The app-server parent
/// supplies owner_scope; Gateway public RPC never accepts this field.
pub fn retain_draft_attachments(
    session_directory: &Path,
    params: &AttachmentDraftRetainParams,
    staged: &mut AttachmentDirectories,
) -> Result<AttachmentDraftRetainResult> {
    anyhow::ensure!(
        params.owner_scope.len() == 64
            && params
                .owner_scope
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "invalid draft owner scope"
    );
    anyhow::ensure!(
        !params.thread_id.is_empty()
            && params.thread_id.len() <= 128
            && !params.thread_id.chars().any(char::is_control),
        "invalid draft thread"
    );
    anyhow::ensure!(
        !params.paths.is_empty()
            && params.paths.len() <= MAX_DRAFTS
            && params.paths.iter().collect::<HashSet<_>>().len() == params.paths.len(),
        "invalid draft paths"
    );
    let session = PrivateDirectory::open_existing(session_directory)?;
    session.verify_private_directory()?;
    let root = session.open_child(OsStr::new("draft-attachments"), true)?;
    root.verify_private_directory()?;
    staged.drafts.retain(|_, draft| draft.is_live());
    let _transaction = lock(&root, "transaction.lock")?;
    // A writer holds transaction.lock through publication. Only unpublished
    // temporary directories can remain here after its process exits.
    for name in root.entry_names_bounded(MAX_DRAFTS * 2 + 2)? {
        if name.to_str().is_some_and(|name| {
            name.starts_with("preparing-")
                && name.len() == 74
                && name[10..].bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            root.open_child(&name, false)?.verify_private_directory()?;
            root.remove_child_tree(&name)?;
        }
    }
    // Match relocated addresses and in-memory ownership keys on Windows.
    let root_path = session_directory.join("draft-attachments").canonicalize()?;
    let mut results = Vec::new();
    for source in &params.paths {
        anyhow::ensure!(
            source.len() <= 4096 && !source.chars().any(char::is_control),
            "invalid draft path"
        );
        let source_path =
            super::relocation::resolve_session_path(session_directory, Path::new(source))?
                .unwrap_or_else(|| PathBuf::from(source));
        let entry_name = if let Ok(relative) =
            kcoder_config::storage::node_storage_relative_path(&source_path, &root_path)
        {
            let parts = relative.components().collect::<Vec<_>>();
            anyhow::ensure!(
                parts.len() == 3 && parts[1].as_os_str() == "content",
                "invalid durable draft path"
            );
            let entry = parts[0]
                .as_os_str()
                .to_str()
                .context("invalid draft entry")?;
            anyhow::ensure!(
                entry.len() == 66
                    && entry.starts_with("d-")
                    && entry[2..].bytes().all(|byte| byte.is_ascii_hexdigit()),
                "invalid draft entry"
            );
            entry.to_owned()
        } else {
            format!(
                "d-{}",
                hex_sha256(&serde_json::to_vec(&(&params.owner_scope, source))?)
            )
        };
        let mut existing = root.entry_names_bounded(MAX_DRAFTS + 2)?;
        let present = existing.iter().any(|name| name == OsStr::new(&entry_name));
        if !present {
            anyhow::ensure!(
                !params.recover_only,
                "draft receipt not found; refusing path adoption"
            );
            anyhow::ensure!(
                staged.staged_files.contains(&source_path),
                "draft source is not owned by this connection"
            );
            // Finish only previously committed deletions. Confirmed drafts never
            // expire merely because their client or transport is disconnected.
            for name in existing
                .iter()
                .filter(|name| *name != OsStr::new("transaction.lock"))
            {
                let directory = root.open_child(name, false)?;
                directory.verify_private_directory()?;
                if read_record(&directory)?.released {
                    let lease = match lock(&directory, "owner.lock") {
                        Ok(lease) => lease,
                        // The owner may have published release but not yet
                        // dropped its lease. Leave that entry for the next writer.
                        Err(error)
                            if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                                error.kind() == std::io::ErrorKind::WouldBlock
                                    || error.raw_os_error()
                                        == fs2::lock_contended_error().raw_os_error()
                            }) =>
                        {
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    drop(lease);
                    drop(directory);
                    root.remove_child_tree(name)?;
                }
            }
            existing = root.entry_names_bounded(MAX_DRAFTS + 2)?;
            anyhow::ensure!(
                existing.len() <= MAX_DRAFTS,
                "draft attachment capacity reached"
            );
            let mut reserved = 0u64;
            for name in existing
                .iter()
                .filter(|name| *name != OsStr::new("transaction.lock"))
            {
                let directory = root.open_child(name, false)?;
                directory.verify_private_directory()?;
                reserved = reserved.saturating_add(read_record(&directory)?.size);
            }
            let bytes = read_private_staged_attachment(&source_path)?;
            anyhow::ensure!(
                reserved.saturating_add(bytes.len() as u64) <= MAX_STAGED_ATTACHMENT_BYTES,
                "draft byte capacity reached"
            );
            let filename = source_path
                .file_name()
                .and_then(OsStr::to_str)
                .context("invalid draft filename")?
                .to_owned();
            validate_attachment_filename(&filename)?;
            let temporary_name = format!("preparing-{}", &entry_name[2..]);
            let directory = root.create_private_child(OsStr::new(&temporary_name))?;
            let write = (|| -> Result<()> {
                let content = directory.create_private_child(OsStr::new("content"))?;
                content.atomic_replace(OsStr::new(&filename), &bytes)?;
                directory.atomic_replace(
                    OsStr::new(RECORD),
                    &serde_json::to_vec(&Record {
                        version: 1,
                        owner_scope: params.owner_scope.clone(),
                        thread_id: params.thread_id.clone(),
                        source_path: source.clone(),
                        filename,
                        size: bytes.len() as u64,
                        sha256: hex_sha256(&bytes),
                        released: false,
                    })?,
                )
            })();
            drop(directory);
            if let Err(error) = write {
                let _ = root.remove_child_tree(OsStr::new(&temporary_name));
                return Err(error);
            }
            root.rename_no_replace(OsStr::new(&temporary_name), OsStr::new(&entry_name))?;
        }
        let directory = root.open_child(OsStr::new(&entry_name), false)?;
        directory.verify_private_directory()?;
        let record = read_record(&directory)?;
        anyhow::ensure!(
            !record.released
                && record.owner_scope == params.owner_scope
                && record.thread_id == params.thread_id,
            "draft attachment belongs to another authority or was released"
        );
        let path = root_path
            .join(&entry_name)
            .join("content")
            .join(&record.filename);
        anyhow::ensure!(
            kcoder_config::storage::node_storage_relative_path(&source_path, &path)
                .is_ok_and(|relative| relative.as_os_str().is_empty())
                || source == &record.source_path,
            "draft path does not match its receipt"
        );
        if !staged.drafts.contains_key(&path) {
            let lease = lock(&directory, "owner.lock")?;
            // The previous owner can publish release while we hold the root
            // transaction. Recheck after acquiring its exclusive lease.
            anyhow::ensure!(
                !read_record(&directory)?.released,
                "draft was released before ownership transfer"
            );
            let content = directory.open_child(OsStr::new("content"), false)?;
            content.verify_private_directory()?;
            let file = content.open_single_link_regular_file(OsStr::new(&record.filename))?;
            anyhow::ensure!(file.metadata()?.len() == record.size, "draft size changed");
            let mut bytes = Vec::new();
            file.take(MAX_ATTACHMENT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            anyhow::ensure!(
                bytes.len() as u64 == record.size && hex_sha256(&bytes) == record.sha256,
                "draft bytes changed"
            );
            staged.drafts.insert(
                path.clone(),
                OwnedDraft {
                    storage: Arc::new(std::sync::Mutex::new(DraftStorage {
                        root: PrivateDirectory::open_existing(&root_path)?,
                        entry: entry_name,
                        lease: Some(lease),
                        steer_pending: false,
                    })),
                    history_root: session_directory.join("attachments"),
                    pending_turn: None,
                    source_path: PathBuf::from(&record.source_path),
                    size: record.size,
                    sha256: record.sha256,
                },
            );
        }
        anyhow::ensure!(
            staged.drafts[&path].pending_turn.is_none() && staged.drafts[&path].is_available(),
            "draft is being materialized; recover the original turn receipt"
        );
        results.push(AttachmentDraftPath {
            source_path: source.clone(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(AttachmentDraftRetainResult { drafts: results })
}

impl AttachmentDirectories {
    /// Called only after the original turn acceptance is durable. History bytes
    /// are separate; cleanup failure must never change an accepted outcome.
    pub fn commit_draft_turn(&mut self, thread: &str, turn: &str) -> Result<()> {
        let paths = self
            .drafts
            .iter()
            .filter(|(_, draft)| {
                draft
                    .pending_turn
                    .as_ref()
                    .is_some_and(|(t, u)| t == thread && u == turn)
            })
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        let mut result = Ok(());
        for path in paths {
            let removed = self.drafts.get_mut(&path).expect("draft found").remove();
            if removed.is_ok() {
                self.drafts.remove(&path);
            }
            result = result.and(removed);
        }
        result
    }
}

#[cfg(test)]
#[path = "drafts_tests.rs"]
mod tests;
