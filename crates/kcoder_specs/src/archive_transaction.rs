//! Recoverable publication of prepared spec files. The durable journal is the
//! merge commit point; moving the change directory is the archive commit point.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Component, Path, PathBuf},
};

const JOURNAL: &str = "archive-transaction.journal";
const MAX_JOURNAL: u64 = 32 * 1024 * 1024;
#[cfg(test)]
#[path = "change_publication_tests.rs"]
mod change_publication_tests;
#[cfg(test)]
thread_local! {
    static FAIL_BEFORE_PUBLICATION: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    static FAIL_AFTER_JOURNAL_REMOVAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct PreparedFile {
    pub relative: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
impl PreparedFile {
    pub(crate) fn changed(&self) -> bool {
        self.before.as_ref() != Some(&self.after)
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ArchiveMove {
    pub source: String,
    pub target: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    #[serde(default)]
    committed: bool,
    files: Vec<PreparedFile>,
    archive: Option<ArchiveMove>,
    #[serde(default)]
    change_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SpecPublicationReceipt {
    pub committed: bool,
    pub recovery_pending: bool,
}

pub(crate) fn recover_change_locked(root: &Path, name: &str) -> Result<()> {
    let directory = PrivateDirectory::open_existing(root)?;
    if let Some(bytes) = current(&directory, JOURNAL)? {
        let journal: Journal = serde_json::from_slice(&bytes)?;
        let owner = journal.change_name.as_deref().or_else(|| {
            journal
                .archive
                .as_ref()
                .map(|archive| archive.source.as_str())
        });
        ensure!(
            owner.is_none_or(|owner| owner == name),
            "spec_transaction_pending: change '{}' has a pending transaction; finish its recovery before changing '{}'",
            owner.unwrap_or("unknown"),
            name
        );
    }
    recover_locked(root)
}

pub(crate) fn lock(root: &Path) -> Result<std::fs::File> {
    let directory = PrivateDirectory::open_or_create(root)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Some(file) = directory.try_exclusive_lock(OsStr::new("archive-transaction.lock"))? {
            return Ok(file);
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "spec_transaction_busy: archive lock timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
fn destination(root: &Path, relative: &Path) -> Result<(PrivateDirectory, String)> {
    let mut parts = relative.components().peekable();
    let mut directory = PrivateDirectory::open_existing(root)?;
    while let Some(part) = parts.next() {
        let Component::Normal(part) = part else {
            anyhow::bail!("spec_transaction_corrupt: invalid relative path");
        };
        if parts.peek().is_none() {
            return Ok((
                directory,
                part.to_str().context("invalid spec filename")?.into(),
            ));
        }
        directory = directory.open_child(part, true)?;
    }
    anyhow::bail!("spec_transaction_corrupt: empty relative path")
}
fn current(directory: &PrivateDirectory, leaf: &str) -> Result<Option<Vec<u8>>> {
    match directory.open_regular_file(OsStr::new(leaf)) {
        Ok(file) => {
            ensure!(
                file.metadata()?.len() <= MAX_JOURNAL,
                "spec_transaction_quota: spec file too large"
            );
            let mut bytes = vec![];
            file.take(MAX_JOURNAL + 1).read_to_end(&mut bytes)?;
            Ok(Some(bytes))
        }
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}
pub(crate) fn prepare_file(root: &Path, relative: &Path, after: Vec<u8>) -> Result<PreparedFile> {
    let (directory, leaf) = destination(root, relative)?;
    let before = current(&directory, &leaf)?;
    // Probe every destination before committing, using the same durable writer.
    let probe = format!(".{leaf}.archive-prepared");
    directory.atomic_replace(OsStr::new(&probe), &after)?;
    directory.remove_regular_file(OsStr::new(&probe))?;
    Ok(PreparedFile {
        relative: relative.into(),
        before,
        after,
    })
}
pub(crate) fn input_guard(root: &Path, relative: &Path, expected: &[u8]) -> Result<PreparedFile> {
    let (directory, leaf) = destination(root, relative)?;
    let before = current(&directory, &leaf)?;
    ensure!(
        before.as_deref() == Some(expected),
        "spec_transaction_conflict: input changed while preparing {}",
        relative.display()
    );
    Ok(PreparedFile {
        relative: relative.into(),
        before,
        after: expected.into(),
    })
}
pub(crate) fn prepare_expected(
    root: &Path,
    relative: &Path,
    after: Vec<u8>,
    expected: Option<&[u8]>,
) -> Result<PreparedFile> {
    let file = prepare_file(root, relative, after)?;
    ensure!(
        file.before.as_deref() == expected,
        "spec_transaction_conflict: input changed while preparing {}",
        relative.display()
    );
    Ok(file)
}
pub(crate) fn ensure_absent(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => anyhow::bail!("archive target {:?} already exists", path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).context("failed to inspect archive target"),
    }
}
pub(crate) fn commit(
    root: &Path,
    files: Vec<PreparedFile>,
    archive: Option<ArchiveMove>,
) -> Result<()> {
    commit_scoped(root, files, archive, None).map(|_| ())
}

pub(crate) fn commit_change(
    root: &Path,
    name: &str,
    files: Vec<PreparedFile>,
) -> Result<SpecPublicationReceipt> {
    crate::workspace_paths::validate_change_name(name)?;
    commit_scoped(root, files, None, Some(name.into()))
}

fn commit_scoped(
    root: &Path,
    files: Vec<PreparedFile>,
    archive: Option<ArchiveMove>,
    change_name: Option<String>,
) -> Result<SpecPublicationReceipt> {
    let directory = PrivateDirectory::open_existing(root)?;
    ensure!(
        current(&directory, JOURNAL)?.is_none(),
        "spec_transaction_pending: pending journal must be recovered before another commit"
    );
    for file in &files {
        let (directory, leaf) = destination(root, &file.relative)?;
        ensure!(
            current(&directory, &leaf)? == file.before,
            "spec_transaction_conflict: {} changed before commit",
            file.relative.display()
        );
    }
    if let Some(move_) = &archive {
        crate::workspace_paths::validate_change_name(&move_.source)?;
        crate::workspace_paths::validate_change_name(&move_.target)?;
        ensure_absent(&root.join("changes/archive").join(&move_.target))?;
    }
    let mut journal = Journal {
        committed: archive.is_none(),
        files,
        archive,
        change_name,
    };
    let bytes = serde_json::to_vec(&journal)?;
    ensure!(
        bytes.len() as u64 <= MAX_JOURNAL,
        "spec_transaction_quota: prepared archive exceeds 32 MiB"
    );
    // Publication can succeed before a directory-flush error is reported.
    if let Err(error) = directory.atomic_replace(OsStr::new(JOURNAL), &bytes)
        && current(&directory, JOURNAL)?.as_deref() != Some(bytes.as_slice())
    {
        return Err(error);
    }
    if let Some(move_) = &journal.archive {
        let source = root.join("changes").join(&move_.source);
        let target = root.join("changes/archive").join(&move_.target);
        if let Err(error) = rename_no_replace(&source, &target) {
            // A rename may succeed before its directory flush reports failure.
            if source.exists() || !target.exists() {
                directory.remove_regular_file(OsStr::new(JOURNAL))?;
                return Err(error).context("archive not committed; authoritative specs unchanged");
            }
        }
    }
    if journal.archive.is_some() {
        journal.committed = true;
        if let Err(error) =
            directory.atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal)?)
        {
            tracing::warn!(
                "spec archive committed; journal publication recovery pending: {error:#}"
            );
            return Ok(SpecPublicationReceipt {
                committed: true,
                recovery_pending: true,
            });
        }
    }
    // Errors after the commit point are recovery-pending, never uncommitted errors.
    if let Err(error) = recover_locked(root) {
        tracing::warn!(
            "spec archive committed; publication recovery pending in {}: {error:#}",
            root.join(JOURNAL).display()
        );
        return Ok(SpecPublicationReceipt {
            committed: true,
            recovery_pending: true,
        });
    }
    Ok(SpecPublicationReceipt {
        committed: true,
        recovery_pending: false,
    })
}

#[cfg(target_os = "linux")]
fn rename_no_replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to move change without replacing archive target");
    }
    Ok(())
}
#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> Result<()> {
    // Windows directory rename rejects an existing destination.
    std::fs::rename(source, target)
        .context("failed to move change without replacing archive target")
}
#[cfg(not(any(target_os = "linux", windows)))]
fn rename_no_replace(_: &Path, _: &Path) -> Result<()> {
    anyhow::bail!("spec_transaction_unsupported: atomic no-replace archive rename is unavailable")
}

/// Finish a committed archive after process interruption. Conflicting external
/// edits are retained and the journal remains available for explicit repair.
pub fn recover_archives(root: &Path) -> Result<()> {
    let _lock = lock(root)?;
    recover_locked(root)
}
pub(crate) fn committed_archive(root: &Path, name: &str) -> Result<Option<PathBuf>> {
    Ok(committed_archive_identity(root)?
        .and_then(|(source, target)| (source == name).then_some(target)))
}
pub(crate) fn committed_archive_identity(root: &Path) -> Result<Option<(String, PathBuf)>> {
    let directory = PrivateDirectory::open_existing(root)?;
    let Some(bytes) = current(&directory, JOURNAL)? else {
        return Ok(None);
    };
    let journal: Journal = serde_json::from_slice(&bytes)?;
    if let Some(move_) = journal.archive {
        crate::workspace_paths::validate_change_name(&move_.source)?;
        crate::workspace_paths::validate_change_name(&move_.target)?;
        let archived = root.join("changes/archive").join(move_.target);
        if (journal.committed || !root.join("changes").join(&move_.source).exists())
            && archived.is_dir()
        {
            return Ok(Some((move_.source, archived)));
        }
    }
    Ok(None)
}
pub(crate) fn recover_locked(root: &Path) -> Result<()> {
    let directory = PrivateDirectory::open_existing(root)?;
    let Some(bytes) = current(&directory, JOURNAL)? else {
        return Ok(());
    };
    let journal: Journal =
        serde_json::from_slice(&bytes).context("invalid spec archive journal")?;
    if let Some(move_) = &journal.archive {
        crate::workspace_paths::validate_change_name(&move_.source)?;
        crate::workspace_paths::validate_change_name(&move_.target)?;
        if root.join("changes").join(&move_.source).exists() {
            ensure!(
                !journal.committed && !root.join("changes/archive").join(&move_.target).exists(),
                "spec_transaction_conflict: source and archive coexist; committed journal retained"
            );
            // The prepared archive never crossed its rename commit point.
            directory.remove_regular_file(OsStr::new(JOURNAL))?;
            return Ok(());
        }
        ensure!(
            root.join("changes/archive").join(&move_.target).is_dir(),
            "spec_transaction_conflict: committed archive directory is missing"
        );
        // Persist the move before publishing any authoritative file.
        PrivateDirectory::open_existing(&root.join("changes"))?.sync()?;
        PrivateDirectory::open_existing(&root.join("changes/archive"))?.sync()?;
    }
    for (index, mut file) in journal.files.into_iter().enumerate() {
        #[cfg(not(test))]
        let _ = index;
        if let Some(move_) = &journal.archive {
            let source = Path::new("changes").join(&move_.source);
            if let Ok(suffix) = file.relative.strip_prefix(source) {
                file.relative = Path::new("changes/archive")
                    .join(&move_.target)
                    .join(suffix);
            }
        }
        let (parent, leaf) = destination(root, &file.relative)?;
        let live = current(&parent, &leaf)?;
        if live.as_ref() == Some(&file.after) {
            continue;
        }
        ensure!(
            live == file.before,
            "spec_transaction_conflict: {} changed during committed archive; journal retained",
            file.relative.display()
        );
        #[cfg(test)]
        ensure!(
            FAIL_BEFORE_PUBLICATION.with(|fault| fault.get()) != Some(index),
            "injected spec publication failure"
        );
        let expected = file.before.as_deref();
        parent.atomic_publish_from_reader(
            OsStr::new(&leaf),
            &mut file.after.as_slice(),
            expected.is_some(),
            || {
                ensure!(
                    current(&parent, &leaf)?.as_deref() == expected,
                    "spec_transaction_conflict: {} changed immediately before publication",
                    file.relative.display()
                );
                Ok(parent
                    .open_regular_file(OsStr::new(&leaf))
                    .ok()
                    .map(|file| file.metadata())
                    .transpose()?
                    .map(|meta| meta.permissions()))
            },
        )?;
    }
    directory.remove_regular_file(OsStr::new(JOURNAL))?;
    #[cfg(test)]
    ensure!(
        !FAIL_AFTER_JOURNAL_REMOVAL.with(|fault| fault.get()),
        "injected journal removal sync failure"
    );
    directory.sync()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("specs/a")).unwrap();
        std::fs::create_dir_all(temp.path().join("specs/b")).unwrap();
        std::fs::write(temp.path().join("specs/a/spec.md"), "old-a").unwrap();
        std::fs::write(temp.path().join("specs/b/spec.md"), "old-b").unwrap();
        temp
    }
    fn journal(temp: &tempfile::TempDir) -> Journal {
        Journal {
            committed: true,
            files: ["a", "b"]
                .into_iter()
                .map(|id| {
                    prepare_file(
                        temp.path(),
                        &Path::new("specs").join(id).join("spec.md"),
                        format!("new-{id}").into_bytes(),
                    )
                    .unwrap()
                })
                .collect(),
            archive: None,
            change_name: None,
        }
    }
    #[test]
    fn final_revision_check_rejects_a_late_edit_before_commit() {
        let temp = fixture();
        let prepared = journal(&temp);
        std::fs::write(temp.path().join("specs/b/spec.md"), "external").unwrap();
        assert!(commit(temp.path(), prepared.files, None).is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("specs/a/spec.md")).unwrap(),
            "old-a"
        );
        assert!(!temp.path().join(JOURNAL).exists());
    }
    #[test]
    fn committed_partial_publication_recovers_idempotently_after_restart() {
        let temp = fixture();
        let prepared = journal(&temp);
        std::fs::write(
            temp.path().join(JOURNAL),
            serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        std::fs::write(temp.path().join("specs/a/spec.md"), "new-a").unwrap();
        recover_archives(temp.path()).unwrap();
        recover_archives(temp.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("specs/b/spec.md")).unwrap(),
            "new-b"
        );
        assert!(!temp.path().join(JOURNAL).exists());
    }
    #[test]
    fn recovery_keeps_external_conflict_and_its_durable_journal() {
        let temp = fixture();
        let prepared = journal(&temp);
        std::fs::write(
            temp.path().join(JOURNAL),
            serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        std::fs::write(temp.path().join("specs/b/spec.md"), "external").unwrap();
        assert!(recover_archives(temp.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("specs/b/spec.md")).unwrap(),
            "external"
        );
        assert!(temp.path().join(JOURNAL).exists());
        std::fs::write(temp.path().join("specs/b/spec.md"), "old-b").unwrap();
        recover_archives(temp.path()).unwrap();
    }
    #[test]
    fn prepared_archive_with_failed_move_never_publishes_specs() {
        let temp = fixture();
        let mut prepared = journal(&temp);
        std::fs::create_dir_all(temp.path().join("changes/source")).unwrap();
        prepared.committed = false;
        prepared.archive = Some(ArchiveMove {
            source: "source".into(),
            target: "target".into(),
        });
        std::fs::write(
            temp.path().join(JOURNAL),
            serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        recover_archives(temp.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("specs/a/spec.md")).unwrap(),
            "old-a"
        );
        assert!(temp.path().join("changes/source").exists());
    }
    #[test]
    fn rename_failure_keeps_authoritative_files_and_discards_uncommitted_journal() {
        let temp = fixture();
        let prepared = journal(&temp);
        std::fs::create_dir_all(temp.path().join("changes/archive")).unwrap();
        assert!(
            commit(
                temp.path(),
                prepared.files,
                Some(ArchiveMove {
                    source: "missing".into(),
                    target: "target".into()
                })
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("specs/a/spec.md")).unwrap(),
            "old-a"
        );
        assert!(!temp.path().join(JOURNAL).exists());
    }
    #[test]
    fn archive_reports_committed_recovery_pending_after_second_file_publication_failure() {
        let temp = tempfile::tempdir().unwrap();
        crate::init(temp.path()).unwrap();
        let change = crate::new_change(temp.path(), "fault", None).unwrap();
        std::fs::write(change.join("tasks.md"), "- [x] complete\n").unwrap();
        std::fs::create_dir_all(change.join("specs/second")).unwrap();
        for domain in ["core", "second"] {
            std::fs::write(change.join("specs").join(domain).join("spec.md"), "## ADDED Requirements\n\n### Requirement: new\nNew.\n\n#### Scenario: new\n- WHEN called\n- THEN works\n").unwrap();
        }
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(Some(1)));
        let result = crate::archive_with_outcome(temp.path(), "fault");
        FAIL_BEFORE_PUBLICATION.with(|fault| fault.set(None));
        let outcome = result.unwrap();
        assert!(outcome.committed && outcome.recovery_pending);
        assert!(!change.exists());
        let root = temp.path().join(crate::SPECS_DIR);
        assert!(
            std::fs::read_to_string(root.join("specs/core/spec.md"))
                .unwrap()
                .contains("Requirement: new")
        );
        assert!(root.join(JOURNAL).exists());
        recover_archives(&root).unwrap();
        let retry = crate::archive_with_outcome(temp.path(), "fault").unwrap();
        assert!(retry.committed && !retry.recovery_pending);
        assert_eq!(retry.archive_dir, outcome.archive_dir);
        assert!(
            std::fs::read_to_string(root.join("specs/second/spec.md"))
                .unwrap()
                .contains("Requirement: new")
        );
    }
    fn yesterday_pending_archive() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        crate::init(temp.path()).unwrap();
        let change = crate::new_change(temp.path(), "prior", None).unwrap();
        crate::new_change(temp.path(), "unrelated", None).unwrap();
        std::fs::write(change.join("tasks.md"), "- [x] complete\n").unwrap();
        std::fs::create_dir_all(change.join("specs/second")).unwrap();
        for domain in ["core", "second"] {
            std::fs::write(change.join("specs").join(domain).join("spec.md"), "## ADDED Requirements\n\n### Requirement: recovered\nRecovered.\n\n#### Scenario: recovered\n- WHEN called\n- THEN works\n").unwrap();
        }
        let root = temp.path().join(crate::SPECS_DIR);
        let mut files = crate::merge::prepare_change(&root, &change).unwrap();
        let mut metadata =
            crate::change_lifecycle::read_metadata(&change.join(".spec.yaml")).unwrap();
        metadata.status = crate::ChangeStatus::Archived;
        files.push(
            prepare_file(
                &root,
                Path::new("changes/prior/.spec.yaml"),
                serde_yaml::to_string(&metadata).unwrap().into_bytes(),
            )
            .unwrap(),
        );
        let date = (chrono::Local::now() - chrono::Duration::days(1)).format("%Y-%m-%d");
        let target_name = format!("{date}-prior");
        let target = root.join("changes/archive").join(&target_name);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::rename(&change, &target).unwrap();
        let first = files
            .iter()
            .find(|file| file.relative == Path::new("specs/core/spec.md"))
            .unwrap();
        std::fs::write(root.join(&first.relative), &first.after).unwrap();
        let journal = Journal {
            committed: true,
            files,
            archive: Some(ArchiveMove {
                source: "prior".into(),
                target: target_name,
            }),
            change_name: None,
        };
        std::fs::write(root.join(JOURNAL), serde_json::to_vec(&journal).unwrap()).unwrap();
        (temp, target)
    }
    #[test]
    fn cross_day_retry_returns_the_journal_target_after_finishing_publication() {
        let (temp, target) = yesterday_pending_archive();
        let outcome = crate::archive_with_outcome(temp.path(), "prior").unwrap();
        assert!(outcome.committed && !outcome.recovery_pending);
        assert_eq!(outcome.archive_dir, target);
        let root = temp.path().join(crate::SPECS_DIR);
        assert!(!root.join(JOURNAL).exists());
        assert!(
            std::fs::read_to_string(root.join("specs/second/spec.md"))
                .unwrap()
                .contains("Requirement: recovered")
        );
    }
    #[test]
    fn cross_day_completed_archive_retry_returns_the_retained_archive() {
        let (temp, target) = yesterday_pending_archive();
        recover_archives(&temp.path().join(crate::SPECS_DIR)).unwrap();
        let outcome = crate::archive_with_outcome(temp.path(), "prior").unwrap();
        assert!(outcome.committed && !outcome.recovery_pending);
        assert_eq!(outcome.archive_dir, target);
    }
    #[test]
    fn another_change_cannot_silently_recover_the_committed_archive() {
        let (temp, _) = yesterday_pending_archive();
        let root = temp.path().join(crate::SPECS_DIR);
        let error = crate::archive_with_outcome(temp.path(), "unrelated").unwrap_err();
        assert!(
            !root.join("specs/second/spec.md").exists(),
            "another change must not mutate the pending archive"
        );
        assert!(root.join(JOURNAL).exists());
        assert!(error.to_string().contains("prior"), "{error:#}");
    }
    #[test]
    fn active_reused_change_name_does_not_return_an_older_archive() {
        let (temp, old_target) = yesterday_pending_archive();
        recover_archives(&temp.path().join(crate::SPECS_DIR)).unwrap();
        let active =
            crate::new_change(temp.path(), "prior", Some("New active change".into())).unwrap();
        std::fs::write(active.join("tasks.md"), "- [x] complete\n").unwrap();
        let outcome = crate::archive_with_outcome(temp.path(), "prior").unwrap();
        assert_ne!(outcome.archive_dir, old_target);
        assert!(outcome.archive_dir.exists() && old_target.exists());
        assert!(!active.exists());
        assert_eq!(
            crate::change_lifecycle::read_metadata(&outcome.archive_dir.join(".spec.yaml"))
                .unwrap()
                .title
                .as_deref(),
            Some("New active change")
        );
    }
    #[test]
    fn retained_archive_lookup_returns_the_latest_matching_date() {
        let (temp, latest) = yesterday_pending_archive();
        recover_archives(&temp.path().join(crate::SPECS_DIR)).unwrap();
        let latest_name = latest.file_name().unwrap().to_str().unwrap();
        let date = chrono::NaiveDate::parse_from_str(
            latest_name.strip_suffix("-prior").unwrap(),
            "%Y-%m-%d",
        )
        .unwrap();
        let older = latest
            .parent()
            .unwrap()
            .join(format!("{}-prior", date - chrono::Duration::days(1)));
        std::fs::create_dir(&older).unwrap();
        std::fs::copy(latest.join(".spec.yaml"), older.join(".spec.yaml")).unwrap();
        assert_eq!(
            crate::archive_with_outcome(temp.path(), "prior")
                .unwrap()
                .archive_dir,
            latest
        );
    }
    #[test]
    fn recovery_error_after_journal_removal_keeps_the_committed_target_outcome() {
        let (temp, target) = yesterday_pending_archive();
        FAIL_AFTER_JOURNAL_REMOVAL.with(|fault| fault.set(true));
        let result = crate::archive_with_outcome(temp.path(), "prior");
        FAIL_AFTER_JOURNAL_REMOVAL.with(|fault| fault.set(false));
        let outcome = result.unwrap();
        assert!(outcome.committed && outcome.recovery_pending);
        assert_eq!(outcome.archive_dir, target);
        let root = temp.path().join(crate::SPECS_DIR);
        assert!(!root.join(JOURNAL).exists());
        assert!(root.join("specs/second/spec.md").exists());
        let retry = crate::archive_with_outcome(temp.path(), "prior").unwrap();
        assert!(retry.committed && !retry.recovery_pending);
    }
}
