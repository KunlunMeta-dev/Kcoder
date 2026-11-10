//! Reuse only pure parsing/structure proofs; live authority and descriptors remain caller checks.
use super::*;
use kcoder_config::PortableLeaseIdentity;
use std::sync::{Arc, Mutex};

#[cfg(test)]
thread_local! { static PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

pub(super) struct Snapshot {
    // Keep the original native file alive so an unlinked inode/file ID cannot be recycled.
    _file: std::fs::File,
    identity: PortableLeaseIdentity,
    sha256: [u8; 32],
    document: Arc<Document>,
}
fn read(
    directory: &PrivateDirectory,
) -> Result<(std::fs::File, PortableLeaseIdentity, Vec<u8>, [u8; 32])> {
    directory.verify_private_directory()?;
    let mut file = directory.open_single_link_regular_file(OsStr::new(DOCUMENT))?;
    let identity = directory.portable_regular_handle_identity(&file)?;
    ensure!(
        file.metadata()?.len() <= MAX_DOCUMENT as u64,
        "external_history_lifecycle_budget_exceeded"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_DOCUMENT as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_DOCUMENT,
        "external_history_lifecycle_budget_exceeded"
    );
    ensure!(
        directory.portable_regular_identity(OsStr::new(DOCUMENT))? == identity,
        "external_history_lifecycle_changed"
    );
    let sha256 = Sha256::digest(&bytes).into();
    Ok((file, identity, bytes, sha256))
}
pub(super) fn load(
    directory: &PrivateDirectory,
    cache: &Mutex<Option<Snapshot>>,
) -> Result<Document> {
    // Read and hash the entire current file even on a hit. Timestamps and cached paths
    // cannot prove unchanged contents, directory ownership, or current lock authority.
    let (file, identity, bytes, sha256) = read(directory)?;
    let mut cached = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("external_history_lifecycle_busy"))?;
    if let Some(snapshot) = cached
        .as_ref()
        .filter(|snapshot| snapshot.identity == identity && snapshot.sha256 == sha256)
    {
        let document = Arc::clone(&snapshot.document);
        drop(cached);
        // Deep copies are read-only CPU work, not part of the cache critical section.
        return Ok((*document).clone());
    }
    #[cfg(test)]
    PARSES.with(|count| count.set(count.get() + 1));
    let document: Document = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("external_history_lifecycle_invalid_metadata"))?;
    document.validate()?;
    *cached = Some(Snapshot {
        _file: file,
        identity,
        sha256,
        document: Arc::new(document.clone()),
    });
    Ok(document)
}
pub(super) fn remember(
    directory: &PrivateDirectory,
    written: &[u8],
    document: &Document,
    cache: &Mutex<Option<Snapshot>>,
) -> Result<()> {
    // The caller validated this exact document before its atomic write. Bind the
    // proof to the newly opened real descriptor and matching complete bytes.
    let (file, identity, bytes, sha256) = read(directory)?;
    ensure!(bytes == written, "external_history_lifecycle_changed");
    *cache
        .lock()
        .map_err(|_| anyhow::anyhow!("external_history_lifecycle_busy"))? = Some(Snapshot {
        _file: file,
        identity,
        sha256,
        document: Arc::new(document.clone()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_catalogues_never_recreate_missing_coordinators_or_accept_replaced_lock_identity() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        drop(Catalog::open(&base, true).unwrap().unwrap());
        let original = std::fs::read(root.path().join(DIRECTORY).join(DOCUMENT)).unwrap();
        std::fs::rename(
            root.path().join("mutation.lock"),
            root.path().join("original.lock"),
        )
        .unwrap();
        assert!(Catalog::open(&base, true).is_err());
        assert!(Catalog::open_readonly(&base).is_err());
        assert!(!root.path().join("mutation.lock").exists());
        // This owned fixture simulates a replaced coordinator; no old metadata
        // may be used to acknowledge the new actual file as its original lease.
        drop(
            base.try_exclusive_lock(OsStr::new("mutation.lock"))
                .unwrap()
                .unwrap(),
        );
        assert!(Catalog::open(&base, true).is_err());
        assert!(Catalog::open_readonly(&base).is_err());
        assert_eq!(
            std::fs::read(root.path().join(DIRECTORY).join(DOCUMENT)).unwrap(),
            original
        );
    }

    #[test]
    fn a_structurally_valid_cached_document_never_supplies_current_scope_authority() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        drop(Catalog::open(&base, true).unwrap().unwrap());
        let directory = base.open_child(OsStr::new(DIRECTORY), false).unwrap();
        let guard =
            coordinator::CatalogAdmission::acquire(base.directory_identity().unwrap(), false)
                .unwrap();
        let mut document = guard.document(&directory).unwrap();
        document.scope = "a".repeat(64);
        document.validate().unwrap();
        directory
            .atomic_replace(
                OsStr::new(DOCUMENT),
                &encode(&document, MAX_DOCUMENT).unwrap(),
            )
            .unwrap();
        // Populate a pure structural proof for these bytes, then take the real
        // read-only path: it must still reject the mismatched actual directory scope.
        assert_eq!(guard.document(&directory).unwrap().scope, document.scope);
        let error = Catalog::open_readonly(&base).err().unwrap();
        assert_eq!(error.to_string(), "external_history_lifecycle_wrong_scope");
    }
    #[test]
    fn cached_structure_proof_requires_both_current_full_bytes_and_original_file_identity() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        drop(Catalog::open(&base, true).unwrap().unwrap());
        let directory = base.open_child(OsStr::new(DIRECTORY), false).unwrap();
        let (_, _, original, _) = read(&directory).unwrap();
        let cache = Mutex::new(None);
        PARSES.with(|count| count.set(0));
        let first = load(&directory, &cache).unwrap();
        assert_eq!(load(&directory, &cache).unwrap().scope, first.scope);
        assert_eq!(PARSES.with(|count| count.get()), 1);
        // Same bytes in a replacement inode/Windows file identity are not a cache hit.
        let identity = directory
            .portable_regular_identity(OsStr::new(DOCUMENT))
            .unwrap();
        directory
            .atomic_replace(OsStr::new(DOCUMENT), &original)
            .unwrap();
        assert_ne!(
            directory
                .portable_regular_identity(OsStr::new(DOCUMENT))
                .unwrap(),
            identity
        );
        load(&directory, &cache).unwrap();
        assert_eq!(PARSES.with(|count| count.get()), 2);
        // In-place mutation preserves the descriptor identity, but never its byte proof.
        let path = root.path().join(DIRECTORY).join(DOCUMENT);
        let mut invalid: serde_json::Value = serde_json::from_slice(&original).unwrap();
        invalid["version"] = serde_json::json!(255);
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(load(&directory, &cache).is_err());
        assert_eq!(PARSES.with(|count| count.get()), 3);
        std::fs::write(&path, b"invalid json").unwrap();
        assert!(load(&directory, &cache).is_err());
        assert_eq!(PARSES.with(|count| count.get()), 4);
        // A failed atomic-write observation cannot install a proof for different bytes.
        assert!(remember(&directory, &original, &first, &cache).is_err());
    }
}
