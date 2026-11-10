use super::*;
use kcoder_config::SqliteSourcePart;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::mpsc,
    time::Instant,
};

const ACTOR: &str = "KCODER_OWNED_PROJECT_SQLITE_ACTOR";
const ROOT: &str = "KCODER_OWNED_PROJECT_SQLITE_ROOT";
const DATABASE: &str = "state_5.sqlite";
const SCHEMA: &str = "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL); CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position)); CREATE TABLE unrelated_secret_table(secret BLOB);";
const PROJECT: &str = "INSERT INTO projects VALUES('p-1','Source project','PRIVATE_VENDOR_METADATA',2,123,456); INSERT INTO project_roots VALUES('p-1',0,'/source-only/not-authorized'),('p-1',1,'D:\\foreign-source-root');";

fn wait(path: &Path, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while std::fs::read(path).ok().as_deref() != Some(expected) {
        assert!(
            Instant::now() < deadline,
            "owned SQLite actor checkpoint timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn actor() -> bool {
    let Some(role) = std::env::var_os(ACTOR) else {
        return false;
    };
    let root = PathBuf::from(std::env::var_os(ROOT).unwrap());
    let db = Connection::open(root.join("source").join(DATABASE)).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    db.execute_batch(SCHEMA).unwrap();
    if role == "large" {
        // SQLite writes a genuine large source table. The producer must not read its body.
        db.execute(
            "INSERT INTO unrelated_secret_table VALUES(zeroblob(?))",
            [512 * 1024 * 1024],
        )
        .unwrap();
    }
    let checkpoint: u32 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(checkpoint, 0);
    db.execute_batch(PROJECT).unwrap();
    if role == "writer" {
        db.execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='uncommitted';")
            .unwrap();
    } else if role == "reader" {
        db.execute_batch("BEGIN;").unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM projects", [], |row| row
                .get::<_, u32>(0))
                .unwrap(),
            1
        );
    }
    std::fs::write(root.join("ready"), b"ready").unwrap();
    if role == "cancel" {
        wait(&root.join("command"), b"attempt");
        let error = db
            .execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='peer'; COMMIT;")
            .unwrap_err();
        assert!(
            matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DatabaseBusy)
        );
        std::fs::write(root.join("blocked"), b"blocked").unwrap();
        wait(&root.join("command"), b"retry");
        db.execute_batch("BEGIN IMMEDIATE; UPDATE projects SET name='peer'; COMMIT;")
            .unwrap();
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
        let log = File::create(root.join("actor.log")).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("project_migration::sqlite::tests::{test}"),
                "--nocapture",
            ])
            .env(ACTOR, role)
            .env(ROOT, root)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let actor = Self {
            child,
            root: root.to_owned(),
        };
        wait(&root.join("ready"), b"ready");
        actor
    }
    fn finish(mut self) {
        std::fs::write(self.root.join("finish"), b"finish").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "owned actor failed");
                return;
            }
            assert!(Instant::now() < deadline, "owned actor did not exit");
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
    PrivateDirectory::open_or_create(&root.join("source")).unwrap()
}
fn facts(root: &Path) -> Vec<(String, u64, String)> {
    let mut facts = std::fs::read_dir(root.join("source"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let mut input = File::open(entry.path()).unwrap();
            let mut digest = Sha256::new();
            let mut buffer = [0; 128 * 1024];
            loop {
                let count = input.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            (
                entry.file_name().to_str().unwrap().to_owned(),
                input.metadata().unwrap().len(),
                format!("{:x}", digest.finalize()),
            )
        })
        .collect::<Vec<_>>();
    facts.sort();
    facts
}
fn read(directory: &PrivateDirectory) -> Result<ProjectRegistrySnapshot> {
    read_codex_registry(
        directory,
        OsStr::new(DATABASE),
        &ProjectReadCancellation::default(),
        ProjectReadLimits::default(),
    )
}
fn assert_project(snapshot: &ProjectRegistrySnapshot) {
    assert_eq!(snapshot.projects.len(), 1);
    let project = &snapshot.projects[0];
    assert_eq!(project.name, "Source project");
    assert_eq!(
        project.roots,
        ["/source-only/not-authorized", "D:\\foreign-source-root"]
    );
    assert_eq!(project.created_at_ms, Some(123));
    assert_eq!(project.updated_at_ms, Some(456));
    let text = serde_json::to_string(snapshot).unwrap();
    assert!(!text.contains("PRIVATE_VENDOR_METADATA"));
    assert!(!text.contains("unrelated_secret_table"));
    assert_eq!(snapshot.proof.source_write_attempts, 0);
    assert!(snapshot.proof.actual_read_bytes > 0);
}

#[test]
fn committed_wal_projects_are_visible_with_an_idle_or_concurrent_reader_without_source_mutation() {
    if actor() {
        return;
    }
    for role in ["idle", "reader"] {
        let root = tempfile::tempdir().unwrap();
        let source = source(root.path());
        let actor = OwnedActor::start(
            root.path(),
            "committed_wal_projects_are_visible_with_an_idle_or_concurrent_reader_without_source_mutation",
            role,
        );
        let before = facts(root.path());
        let snapshot = read(&source).unwrap();
        assert_project(&snapshot);
        assert!(snapshot.proof.wal_bytes > 32);
        assert_eq!(before, facts(root.path()));
        actor.finish();
    }
}

#[test]
fn a_live_writer_is_explicitly_busy_and_does_not_receive_a_stale_snapshot() {
    if actor() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let actor = OwnedActor::start(
        root.path(),
        "a_live_writer_is_explicitly_busy_and_does_not_receive_a_stale_snapshot",
        "writer",
    );
    let before = facts(root.path());
    assert_eq!(
        read(&source).err().unwrap().to_string(),
        "migration_project_source_busy"
    );
    assert_eq!(before, facts(root.path()));
    actor.finish();
}

#[test]
fn cancellation_after_the_native_gate_releases_only_its_own_locks_and_never_returns_a_projection() {
    if actor() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let actor = OwnedActor::start(
        root.path(),
        "cancellation_after_the_native_gate_releases_only_its_own_locks_and_never_returns_a_projection",
        "cancel",
    );
    let cancel = ProjectReadCancellation::default();
    let worker_cancel = cancel.clone();
    let (entered, entry) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        read_inner(
            &source,
            OsStr::new(DATABASE),
            &worker_cancel,
            ProjectReadLimits::default(),
            || {
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
            },
        )
    });
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    std::fs::write(root.path().join("command"), b"attempt").unwrap();
    wait(&root.path().join("blocked"), b"blocked");
    cancel.cancel();
    release.send(()).unwrap();
    assert_eq!(
        worker.join().unwrap().err().unwrap().to_string(),
        "migration_project_source_cancelled"
    );
    std::fs::write(root.path().join("command"), b"retry").unwrap();
    wait(&root.path().join("committed"), b"committed");
    actor.finish();
}

#[test]
fn a_half_gibibyte_unrelated_table_is_neither_copied_nor_queried() {
    if actor() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let actor = OwnedActor::start(
        root.path(),
        "a_half_gibibyte_unrelated_table_is_neither_copied_nor_queried",
        "large",
    );
    let before = facts(root.path());
    let snapshot = read(&source).unwrap();
    assert_project(&snapshot);
    assert!(snapshot.proof.database_bytes >= 512 * 1024 * 1024);
    assert!(snapshot.proof.actual_read_bytes < 1024 * 1024);
    assert!(snapshot.proof.elapsed_ms < 1000);
    eprintln!(
        "owned_project_read_metrics={}",
        serde_json::to_string(&snapshot.proof).unwrap()
    );
    assert_eq!(before, facts(root.path()));
    actor.finish();
}

#[test]
fn a_closed_database_never_creates_a_source_sidecar_and_unrelated_sql_is_denied() {
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let db = Connection::open(root.path().join("source").join(DATABASE)).unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute_batch(PROJECT).unwrap();
    drop(db);
    let before = facts(root.path());
    let snapshot = read(&source).unwrap();
    assert_project(&snapshot);
    assert_eq!(snapshot.proof.wal_bytes, 0);
    assert_eq!(before, facts(root.path()));
    let gate = source
        .try_sqlite_source_read_lease(OsStr::new(DATABASE), 1024 * 1024)
        .unwrap()
        .unwrap();
    assert!(gate.fact(SqliteSourcePart::SharedMemory).is_none());
    let registered = vfs::acquire(
        gate,
        ProjectReadCancellation::default(),
        ProjectReadLimits::default(),
    )
    .unwrap();
    let db = Connection::open_with_flags_and_vfs(
        "registry.sqlite",
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        registered.name(),
    )
    .unwrap();
    configure(&db, Arc::clone(&registered.context)).unwrap();
    for sql in [
        "SELECT secret FROM unrelated_secret_table",
        "SELECT metadata FROM projects",
        "SELECT load_extension('/never/open')",
        "UPDATE projects SET name='changed'",
        "ATTACH DATABASE '/never/open' AS other",
    ] {
        assert!(db.prepare(sql).is_err(), "non-allowlisted SQL was accepted");
    }
    drop(db);
    assert_eq!(registered.context.proof().unwrap().source_write_attempts, 0);
    assert_eq!(before, facts(root.path()));
}

#[test]
fn read_budgets_and_replaced_sources_do_not_publish_a_partial_or_rebound_inventory() {
    let root = tempfile::tempdir().unwrap();
    let source = source(root.path());
    let path = root.path().join("source").join(DATABASE);
    let db = Connection::open(&path).unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute_batch(PROJECT).unwrap();
    drop(db);
    let before = facts(root.path());
    let error = read_codex_registry(
        &source,
        OsStr::new(DATABASE),
        &ProjectReadCancellation::default(),
        ProjectReadLimits {
            read_bytes: 32,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert_eq!(
        error.to_string(),
        "migration_project_source_budget_exceeded"
    );
    assert_eq!(before, facts(root.path()));
    let replacement = root.path().join("replacement");
    std::fs::copy(&path, &replacement).unwrap();
    assert!(
        read_inner(
            &source,
            OsStr::new(DATABASE),
            &ProjectReadCancellation::default(),
            ProjectReadLimits::default(),
            || {
                std::fs::rename(&path, root.path().join("held")).unwrap();
                std::fs::rename(&replacement, &path).unwrap();
            }
        )
        .is_err()
    );
}
