//! Real process termination tests for the original sealed SQLite checkpoint.
use super::*;
use crate::external_history::ExternalHistoryStore;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const REVISION: &str = "owned-crash-recovery/1";
const CHILD: &str =
    "external_history::lifecycle::derived_recovery::crash_tests::sealed_projection_writer_child";

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn digest(path: &Path) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(std::fs::read(path)?)))
}

#[test]
fn sealed_cache_process_crash_restores_original_bytes_without_read_side_effects() -> Result<()> {
    let (root, _store, reader) = super::super::derived::tests::empty_budgeted();
    let archive = reader.binding.archive_id.clone();
    let mut original = reader
        .projection(REVISION, true)?
        .context("owned projection missing")?;
    original.finish()?;
    original.seal_for_collection(|| true)?;
    drop(original);
    let database = root
        .path()
        .join("external-history")
        .join(&archive)
        .join(format!(
            "normalized-{:x}",
            Sha256::digest(REVISION.as_bytes())
        ))
        .join("catalog.sqlite3");
    let journal = database.with_file_name("catalog.sqlite3-journal");
    assert!(
        !journal.exists(),
        "the owned fault writer must create its own new journal"
    );
    let before = digest(&database)?;
    let original_bytes = std::fs::metadata(&database)?.len();
    let ready = root.path().join("owned-writer-ready");
    let child_errors = root.path().join("owned-writer-errors");
    let mut child = OwnedChild(
        Command::new(std::env::current_exe()?)
            .args(["--ignored", "--exact", CHILD, "--nocapture"])
            .env("KCODER_OWNED_CACHE_CRASH_ROOT", root.path())
            .env("KCODER_OWNED_CACHE_CRASH_ARCHIVE", &archive)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(std::fs::File::create(&child_errors)?))
            .spawn()?,
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready.exists() {
        if let Some(status) = child.0.try_wait()? {
            let errors = std::fs::read_to_string(&child_errors)?;
            anyhow::bail!(
                "owned writer exited before its dirty-page spill: {status}; {}",
                errors.chars().take(4096).collect::<String>()
            );
        }
        ensure!(
            Instant::now() < deadline,
            "owned writer did not reach its dirty-page spill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let journal_header = std::fs::read(&journal)?;
    ensure!(
        journal_header.starts_with(&[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]),
        "owned writer did not leave a real hot journal"
    );
    child.0.kill()?;
    child.0.wait()?;
    std::fs::remove_file(ready)?;
    let damaged = digest(&database)?;
    assert_ne!(
        damaged, before,
        "the killed writer must actually have spilled dirty pages"
    );
    let hot = digest(&journal)?;
    assert!(
        reader.projection(REVISION, false).is_err(),
        "a read-only observer must not repair a hot journal"
    );
    assert_eq!(digest(&database)?, damaged);
    assert_eq!(digest(&journal)?, hot);
    let mut restored = reader
        .projection(REVISION, true)?
        .context("original checkpoint missing after rollback")?;
    assert!(restored.progress()?.normalization_complete);
    assert_eq!(
        digest(&database)?,
        before,
        "rollback must restore the complete original sealed bytes"
    );
    assert_eq!(std::fs::metadata(&database)?.len(), original_bytes);
    assert!(!journal.exists());
    assert_eq!(
        restored.finish().unwrap_err().to_string(),
        "history_projection_read_only",
        "rollback does not reopen a sealed allocation for writes"
    );
    drop(restored);
    assert!(
        reader
            .projection(REVISION, false)?
            .context("restored observer missing")?
            .progress()?
            .normalization_complete
    );
    assert_eq!(digest(&database)?, before);
    Ok(())
}

#[test]
#[ignore = "owned crash child selected only by its parent regression"]
fn sealed_projection_writer_child() -> Result<()> {
    let root = PathBuf::from(
        std::env::var_os("KCODER_OWNED_CACHE_CRASH_ROOT").context("owned root required")?,
    );
    let archive = std::env::var("KCODER_OWNED_CACHE_CRASH_ARCHIVE")?;
    let store = ExternalHistoryStore::open_existing(&root)
        .context("OWNED_STORE_OPEN")?
        .context("owned store missing")?;
    let reader = store.reader(&archive).context("OWNED_ARCHIVE_OPEN")?;
    let projection = reader
        .projection(REVISION, true)
        .context("ORIGINAL_CHECKPOINT_REOPEN")?
        .context("owned checkpoint missing")?;
    ensure!(
        projection.progress()?.normalization_complete,
        "owned checkpoint not complete"
    );
    // The ordinary native projection lease authenticates this exact fixture. The
    // raw SQLite connection deliberately leaves an unfinished real rollback journal.
    let database = root
        .join("external-history")
        .join(archive)
        .join(format!(
            "normalized-{:x}",
            Sha256::digest(REVISION.as_bytes())
        ))
        .join("catalog.sqlite3");
    // The fixture's ordinary Windows SQLite VFS needs the verbatim absolute
    // spelling for its longer journal suffix too. Production uses held handles.
    let database = std::fs::canonicalize(database)?;
    let connection = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("OWNED_RAW_SQLITE_CONNECTION")?;
    connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE projection_header SET body=zeroblob(1048576) WHERE id=1;").with_context(|| {
        // SAFETY: this diagnostic queries only the live owned SQLite handle.
        let system_error = unsafe { rusqlite::ffi::sqlite3_system_errno(connection.handle()) };
        format!("OWNED_RAW_SQLITE_TRANSACTION system_error={system_error} path_chars={}", database.as_os_str().to_string_lossy().chars().count())
    })?;
    connection.cache_flush().context("OWNED_RAW_SQLITE_SPILL")?;
    #[cfg(windows)]
    {
        // The ordinary SQLite fault injector uses the token's default owner,
        // which may be Administrators. Apply the same private-file ownership
        // as the production writer to this fixture-created journal before the
        // crash. Recovery itself never repairs an unknown file or its ACL.
        kcoder_config::set_user_only_file_permissions(
            &database.with_file_name("catalog.sqlite3-journal"),
        )
        .context("OWNED_RAW_JOURNAL_PRIVATE_OWNER")?;
    }
    std::fs::write(root.join("owned-writer-ready"), b"dirty pages flushed")?;
    loop {
        std::hint::black_box((&projection, &connection));
        std::thread::park_timeout(Duration::from_secs(1));
    }
}
