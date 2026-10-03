use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMetadataDelta, SkillMetadataPatch,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillRevision, SkillStore, SkillStoreError,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;

struct ExitAtPublishing;

impl kcoder_skills::SkillStoreFaultInjector for ExitAtPublishing {
    fn check(&self, point: &'static str) -> Result<(), SkillStoreError> {
        if point == "journal_publishing" {
            std::process::exit(73);
        }
        Ok(())
    }
}

fn package(name: &str, body: &str) -> SkillPackage {
    SkillPackage {
        name: name.to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: format!("---\nname: {name}\ndescription: Process test\n---\n\n{body}\n")
                .into_bytes(),
            executable: false,
        }],
    }
}

fn request(operation_id: &str, mutation: SkillMutation) -> SkillCommitRequest {
    SkillCommitRequest {
        operation_id: operation_id.to_string(),
        actor: SkillMutationActor::System {
            component: "process_test".to_string(),
            session_id: None,
        },
        operation: SkillOperationKind::Patch,
        preconditions: Vec::new(),
        mutations: vec![mutation],
        metadata: Default::default(),
    }
}

#[test]
fn process_worker() {
    let Ok(root) = std::env::var("KCODER_SKILL_STORE_PROCESS_ROOT") else {
        return;
    };
    let barrier = PathBuf::from(std::env::var("KCODER_SKILL_STORE_PROCESS_BARRIER").unwrap());
    while !barrier.exists() {
        std::thread::yield_now();
    }
    let worker = std::env::var("KCODER_SKILL_STORE_PROCESS_WORKER").unwrap();
    let mode =
        std::env::var("KCODER_SKILL_STORE_PROCESS_MODE").unwrap_or_else(|_| "patch".to_string());
    if mode == "builtin" {
        kcoder_skills::ensure_builtin_skills(Path::new(&root)).unwrap();
        fs::write(
            Path::new(&root)
                .parent()
                .unwrap()
                .join(format!("outcome-{worker}")),
            "committed:builtin",
        )
        .unwrap();
        return;
    }
    if mode == "crash" {
        let store = SkillStore::open(Path::new(&root))
            .unwrap()
            .with_fault_injector(Arc::new(ExitAtPublishing));
        let _ = store.commit(request(
            "process-crash-operation",
            SkillMutation::PutPackage {
                package: package("demo", "recovered after crash"),
                expected: ExpectedSkillRevision::Absent,
            },
        ));
        panic!("crash failpoint did not terminate the worker");
    }
    let store = SkillStore::open(Path::new(&root)).unwrap();
    let result = match mode.as_str() {
        "patch" => {
            let expected = SkillRevision(
                std::env::var("KCODER_SKILL_STORE_PROCESS_REVISION").expect("revision is required"),
            );
            store.commit(request(
                &format!("process-worker-{worker}"),
                SkillMutation::PatchText {
                    name: "demo".to_string(),
                    expected: ExpectedSkillRevision::Exact(expected),
                    relative_path: PathBuf::from("SKILL.md"),
                    old_string: "initial".to_string(),
                    new_string: format!("worker-{worker}"),
                    replace_all: false,
                },
            ))
        }
        "provenance" => {
            let mut patch = SkillMetadataPatch::default();
            patch.update.insert(
                "origin".to_string(),
                Value::String("user_created".to_string()),
            );
            store.commit(SkillCommitRequest {
                operation_id: format!("process-provenance-{worker}"),
                actor: SkillMutationActor::System {
                    component: "process_test".to_string(),
                    session_id: None,
                },
                operation: SkillOperationKind::MetadataOnly,
                preconditions: Vec::new(),
                mutations: Vec::new(),
                metadata: SkillMetadataDelta {
                    provenance: BTreeMap::from([(format!("skill-{worker}"), patch)]),
                    ..Default::default()
                },
            })
        }
        "idempotent" => store.commit(request(
            "process-shared-operation",
            SkillMutation::PutPackage {
                package: package("demo", "shared"),
                expected: ExpectedSkillRevision::Absent,
            },
        )),
        "different" => store.commit(request(
            &format!("process-different-{worker}"),
            SkillMutation::PutPackage {
                package: package(&format!("demo-{worker}"), worker.as_str()),
                expected: ExpectedSkillRevision::Absent,
            },
        )),
        other => panic!("unknown worker mode: {other}"),
    };
    let outcome = match result {
        Ok(receipt) => format!("committed:{}", receipt.transaction_id),
        Err(SkillStoreError::Conflict { .. }) => "conflict".to_string(),
        Err(error) => panic!("unexpected worker error: {error}"),
    };
    fs::write(
        Path::new(&root)
            .parent()
            .unwrap()
            .join(format!("outcome-{worker}")),
        outcome,
    )
    .unwrap();
}

fn spawn_workers(root: &Path, barrier: &Path, mode: &str) -> Vec<Child> {
    let executable = std::env::current_exe().unwrap();
    ["a", "b"]
        .into_iter()
        .map(|worker| {
            Command::new(&executable)
                .args(["--exact", "process_worker", "--nocapture"])
                .env("KCODER_SKILL_STORE_PROCESS_ROOT", root)
                .env("KCODER_SKILL_STORE_PROCESS_BARRIER", barrier)
                .env("KCODER_SKILL_STORE_PROCESS_WORKER", worker)
                .env("KCODER_SKILL_STORE_PROCESS_MODE", mode)
                .spawn()
                .unwrap()
        })
        .collect()
}

fn release_and_wait(barrier: &Path, children: Vec<Child>) {
    fs::write(barrier, b"go").unwrap();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
}

#[test]
fn two_processes_cannot_lose_an_update() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    let store = SkillStore::open(&root).unwrap();
    store
        .commit(request(
            "process-initial",
            SkillMutation::PutPackage {
                package: package("demo", "initial"),
                expected: ExpectedSkillRevision::Absent,
            },
        ))
        .unwrap();
    let revision = store.current_revision("demo").unwrap().unwrap();
    let barrier = temp.path().join("start");
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    for worker in ["a", "b"] {
        children.push(
            Command::new(&executable)
                .args(["--exact", "process_worker", "--nocapture"])
                .env("KCODER_SKILL_STORE_PROCESS_ROOT", &root)
                .env("KCODER_SKILL_STORE_PROCESS_BARRIER", &barrier)
                .env("KCODER_SKILL_STORE_PROCESS_WORKER", worker)
                .env("KCODER_SKILL_STORE_PROCESS_MODE", "patch")
                .env("KCODER_SKILL_STORE_PROCESS_REVISION", revision.as_str())
                .spawn()
                .unwrap(),
        );
    }
    release_and_wait(&barrier, children);

    let outcomes = ["a", "b"]
        .map(|worker| fs::read_to_string(temp.path().join(format!("outcome-{worker}"))).unwrap());
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| *outcome == "conflict")
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome.starts_with("committed:"))
            .count(),
        1
    );
    let content = fs::read_to_string(root.join("demo/SKILL.md")).unwrap();
    assert!(content.contains("worker-a") || content.contains("worker-b"));
}

#[test]
fn two_processes_updating_provenance_keep_both_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    let barrier = temp.path().join("start");
    let children = spawn_workers(&root, &barrier, "provenance");
    release_and_wait(&barrier, children);

    let provenance: Value =
        serde_json::from_slice(&fs::read(root.join(".provenance.json")).unwrap()).unwrap();
    assert_eq!(provenance["skills"]["skill-a"]["origin"], "user_created");
    assert_eq!(provenance["skills"]["skill-b"]["origin"], "user_created");
}

#[test]
fn operation_id_retry_across_processes_appends_one_commit() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    let barrier = temp.path().join("start");
    let children = spawn_workers(&root, &barrier, "idempotent");
    release_and_wait(&barrier, children);

    let a = fs::read_to_string(temp.path().join("outcome-a")).unwrap();
    let b = fs::read_to_string(temp.path().join("outcome-b")).unwrap();
    assert_eq!(a, b, "idempotent retries must return the original receipt");
    assert_eq!(
        fs::read_to_string(root.join(".commits.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn two_processes_mutating_different_skills_both_commit() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    let barrier = temp.path().join("start");
    let children = spawn_workers(&root, &barrier, "different");
    release_and_wait(&barrier, children);
    assert!(root.join("demo-a/SKILL.md").is_file());
    assert!(root.join("demo-b/SKILL.md").is_file());
    assert_eq!(
        fs::read_to_string(root.join(".commits.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[test]
fn concurrent_builtin_materialization_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("profile");
    let barrier = temp.path().join("start");
    let children = spawn_workers(&config, &barrier, "builtin");
    release_and_wait(&barrier, children);
    let root = config.join("skills/.builtin");
    assert!(root.join("kcoder-settings/SKILL.md").is_file());
    assert!(root.join(".builtin_manifest").is_file());
    assert_eq!(
        fs::read_to_string(root.join(".commits.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn process_crash_releases_lock_and_next_process_recovers_journal() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("skills");
    let barrier = temp.path().join("start");
    let executable = std::env::current_exe().unwrap();
    let mut child = Command::new(&executable)
        .args(["--exact", "process_worker", "--nocapture"])
        .env("KCODER_SKILL_STORE_PROCESS_ROOT", &root)
        .env("KCODER_SKILL_STORE_PROCESS_BARRIER", &barrier)
        .env("KCODER_SKILL_STORE_PROCESS_WORKER", "crash")
        .env("KCODER_SKILL_STORE_PROCESS_MODE", "crash")
        .spawn()
        .unwrap();
    fs::write(&barrier, b"go").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(73));

    let store = SkillStore::open(&root).unwrap();
    let diagnostics = store.recover().unwrap();
    assert!(diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic,
            kcoder_skills::SkillStoreDiagnostic::Recovered { .. }
        )
    }));
    assert!(
        fs::read_to_string(root.join("demo/SKILL.md"))
            .unwrap()
            .contains("recovered after crash")
    );
}
