use super::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const ROLE: &str = "KCODER_OWNED_SQLITE_SOURCE_ACTOR";
const ROOT: &str = "KCODER_OWNED_SQLITE_SOURCE_ROOT";
const DATABASE: &str = "state.sqlite";

fn wait(path: &Path, value: &[u8]) {
    let end = Instant::now() + Duration::from_secs(15);
    while std::fs::read(path).ok().as_deref() != Some(value) {
        assert!(
            Instant::now() < end,
            "owned SQLite actor did not reach its bounded checkpoint"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn actor() -> bool {
    let Some(role) = std::env::var_os(ROLE) else {
        return false;
    };
    let root = PathBuf::from(std::env::var_os(ROOT).unwrap());
    let db = Connection::open(root.join("source").join(DATABASE)).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
        INSERT INTO projects VALUES('original','committed-only-in-wal');",
    )
    .unwrap();
    if role == "writer" {
        db.execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='uncommitted';")
            .unwrap();
    } else if role == "reader" {
        db.execute_batch("BEGIN;").unwrap();
        assert_eq!(
            db.query_row("SELECT name FROM projects", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "committed-only-in-wal"
        );
    }
    std::fs::write(root.join("ready"), b"ready").unwrap();
    if role == "coordinator" {
        wait(&root.join("command"), b"attempt");
        let error = db
            .execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='peer-write'; COMMIT;")
            .unwrap_err();
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DatabaseBusy)
        );
        let busy: u32 = db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .unwrap();
        assert_eq!(busy, 1);
        std::fs::write(root.join("blocked"), b"blocked").unwrap();
        wait(&root.join("command"), b"retry");
        db.execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='peer-write'; COMMIT;")
            .unwrap();
        let busy: u32 = db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .unwrap();
        assert_eq!(busy, 0);
        std::fs::write(root.join("committed"), b"committed").unwrap();
    }
    wait(&root.join("finish"), b"finish");
    if role == "writer" || role == "reader" {
        db.execute_batch("ROLLBACK;").unwrap();
    }
    true
}

struct OwnedActor {
    child: Child,
    root: PathBuf,
}
impl OwnedActor {
    fn start(root: &Path, test: &str, role: &str) -> Self {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("private_files::sqlite_source::tests::{test}"),
                "--nocapture",
            ])
            .env(ROLE, role)
            .env(ROOT, root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = Self {
            child,
            root: root.to_owned(),
        };
        wait(&root.join("ready"), b"ready");
        result
    }
    fn finish(mut self) {
        std::fs::write(self.root.join("finish"), b"finish").unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < end, "owned SQLite actor did not exit");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for OwnedActor {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
fn source(root: &Path) -> PrivateDirectory {
    let path = root.join("source");
    PrivateDirectory::open_or_create(&path).unwrap()
}
fn facts(root: &Path) -> Vec<(OsString, u64, String)> {
    let mut files = std::fs::read_dir(root.join("source"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let bytes = std::fs::read(entry.path()).unwrap();
            (
                entry.file_name(),
                bytes.len() as u64,
                format!("{:x}", Sha256::digest(bytes)),
            )
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

#[test]
fn idle_and_readonly_sqlite_connections_keep_their_committed_wal_and_source_bytes() {
    if actor() {
        return;
    }
    for role in ["idle", "reader"] {
        let root = tempfile::tempdir().unwrap();
        let source = source(root.path());
        let actor = OwnedActor::start(
            root.path(),
            "idle_and_readonly_sqlite_connections_keep_their_committed_wal_and_source_bytes",
            role,
        );
        let before = facts(root.path());
        let lease = source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024 * 1024)
            .unwrap()
            .unwrap();
        assert!(lease.fact(SqliteSourcePart::Wal).unwrap().bytes > 32);
        let mut header = [0; 16];
        assert_eq!(
            lease
                .read_at(SqliteSourcePart::Database, 0, &mut header)
                .unwrap(),
            16
        );
        assert_eq!(&header, b"SQLite format 3\0");
        lease.verify().unwrap();
        assert_eq!(before, facts(root.path()));
        drop(lease);
        actor.finish();
    }
}

#[test]
fn active_writer_is_busy_without_creating_or_modifying_a_source_file() {
    if actor() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let actor = OwnedActor::start(
        root.path(),
        "active_writer_is_busy_without_creating_or_modifying_a_source_file",
        "writer",
    );
    let before = facts(root.path());
    assert!(
        source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024 * 1024)
            .unwrap()
            .is_none()
    );
    assert_eq!(before, facts(root.path()));
    actor.finish();
}

#[test]
fn read_lease_blocks_real_writes_and_checkpoints_until_the_last_clone_is_released() {
    if actor() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let actor = OwnedActor::start(
        root.path(),
        "read_lease_blocks_real_writes_and_checkpoints_until_the_last_clone_is_released",
        "coordinator",
    );
    let before = facts(root.path());
    let lease = source
        .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024 * 1024)
        .unwrap()
        .unwrap();
    let retained = lease.clone();
    drop(lease);
    std::fs::write(root.path().join("command"), b"attempt").unwrap();
    wait(&root.path().join("blocked"), b"blocked");
    retained.verify().unwrap();
    // This other SQLite process may update its own SHM reader marks even when
    // BEGIN IMMEDIATE/checkpoint is refused. Main and committed WAL stay unchanged;
    // the retained lease separately verifies the original SHM identity and size.
    let data = |rows: Vec<(OsString, u64, String)>| {
        rows.into_iter()
            .filter(|row| row.0 != "state.sqlite-shm")
            .collect::<Vec<_>>()
    };
    assert_eq!(data(before), data(facts(root.path())));
    drop(retained);
    std::fs::write(root.path().join("command"), b"retry").unwrap();
    wait(&root.path().join("committed"), b"committed");
    actor.finish();
}

#[cfg(unix)]
#[test]
fn unsafe_wal_links_and_replaced_names_do_not_receive_a_lease() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let file = root.path().join("source").join(DATABASE);
    std::fs::write(&file, b"SQLite format 3\0").unwrap();
    crate::set_user_only_file_permissions(&file).unwrap();
    let outside = root.path().join("outside");
    std::fs::write(&outside, b"DO_NOT_READ_OUTSIDE").unwrap();
    let wal = root.path().join("source").join("state.sqlite-wal");
    symlink(&outside, &wal).unwrap();
    assert!(
        source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024)
            .is_err()
    );
    std::fs::remove_file(&wal).unwrap();
    std::fs::hard_link(&outside, &wal).unwrap();
    assert!(
        source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024)
            .is_err()
    );
    std::fs::remove_file(&wal).unwrap();
    let lease = source
        .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024)
        .unwrap()
        .unwrap();
    std::fs::rename(&file, root.path().join("held")).unwrap();
    std::fs::write(&file, b"SQLite format 3\0").unwrap();
    crate::set_user_only_file_permissions(&file).unwrap();
    assert!(lease.verify().is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), b"DO_NOT_READ_OUTSIDE");
}

#[test]
fn missing_and_over_budget_sources_are_not_created_or_repaired() {
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    assert!(
        source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 32)
            .is_err()
    );
    assert!(facts(root.path()).is_empty());
    std::fs::write(root.path().join("source").join(DATABASE), [0; 64]).unwrap();
    let before = facts(root.path());
    assert!(
        source
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), 32)
            .is_err()
    );
    assert_eq!(before, facts(root.path()));
}

#[test]
fn raw_same_identity_and_size_mutation_cannot_hide_by_restoring_modified_time() {
    use std::io::Write;
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let path = root.path().join("source").join(DATABASE);
    std::fs::write(&path, b"SQLite format 3\0original").unwrap();
    crate::set_user_only_file_permissions(&path).unwrap();
    let original = std::fs::metadata(&path).unwrap().modified().unwrap();
    let lease = source
        .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024)
        .unwrap()
        .unwrap();
    std::thread::sleep(Duration::from_millis(2));
    let mut raw = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    raw.write_all(b"SQLite format 3\0tampered").unwrap();
    raw.set_times(std::fs::FileTimes::new().set_modified(original))
        .unwrap();
    drop(raw);
    assert!(lease.verify().is_err());
}
