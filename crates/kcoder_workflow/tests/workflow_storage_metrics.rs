//! Opt-in measurements of real storage operations; no provider or workflow execution.
use fs2::FileExt;
use kcoder_types::workflow::{WorkflowNode, WorkflowPosition};
use kcoder_workflow::store::WorkflowStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Arc, Barrier},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
fn snapshot(root: &Path) -> BTreeMap<String, Value> {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Value>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, out);
            } else {
                let bytes = fs::read(&path).unwrap();
                #[cfg(unix)]
                let inode = {
                    use std::os::unix::fs::MetadataExt;
                    fs::metadata(&path).unwrap().ino()
                };
                #[cfg(not(unix))]
                let inode = 0;
                out.insert(path.strip_prefix(root).unwrap().to_string_lossy().into(), json!({"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"inode":inode}));
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}
fn phase<F: FnOnce()>(name: &str, root: &Path, out: &mut Vec<Value>, operation: F) {
    let before = snapshot(root);
    let start = now();
    let clock = Instant::now();
    operation();
    let elapsed = clock.elapsed().as_secs_f64() * 1000.;
    let end = now();
    let after = snapshot(root);
    let changed: Vec<_> = after
        .iter()
        .filter(|(key, value)| before.get(*key) != Some(*value))
        .map(|(key, value)| json!({"path":key,"after":value,"before":before.get(key)}))
        .collect();
    let removed: Vec<_> = before
        .keys()
        .filter(|key| !after.contains_key(*key))
        .collect();
    out.push(json!({"phase":name,"startUnix":start,"endUnix":end,"elapsedMs":elapsed,"changedFiles":changed,"removedFiles":removed}));
}
fn node(text: &str) -> WorkflowNode {
    serde_json::from_value(json!({"id":"one","title":"One","prompt":text,"maxTurns":3})).unwrap()
}

#[test]
#[ignore = "Run only through the owned storage metrics E2E harness with strace"]
fn measure_store_write_scope_and_lock_boundaries() {
    let output =
        std::env::var_os("KCODER_STORAGE_METRICS_OUTPUT").expect("owned report path required");
    let root = std::path::PathBuf::from(
        std::env::var_os("KCODER_STORAGE_METRICS_ROOT").expect("owned library path required"),
    );
    let store = WorkflowStore::new(&root);
    let mut ids = Vec::new();
    for definition in 0..8 {
        let mut draft = store
            .create(
                &format!("Definition {definition}"),
                "Private deterministic measurement",
            )
            .unwrap();
        for version in 0..12 {
            draft = store
                .upsert_node(
                    &draft.id,
                    draft.revision,
                    node(&format!(
                        "definition {definition}, revision {version}: {}",
                        "x".repeat(2048)
                    )),
                )
                .unwrap();
            draft = store.save(&draft.id, draft.revision).unwrap();
        }
        ids.push(draft.id);
        eprintln!("storage_metrics_fixture_definitions:{}", ids.len());
    }
    store.migrate_storage().unwrap();
    let baseline = snapshot(&root);
    let capacity = serde_json::to_value(store.capacity().unwrap()).unwrap();
    let mut phases = Vec::new();
    let draft = store.read(&ids[0]).unwrap();
    phase("layout", &root, &mut phases, || {
        let moved = store
            .move_node(
                &ids[0],
                "one",
                WorkflowPosition::default(),
                WorkflowPosition { x: 10., y: 20. },
            )
            .unwrap();
        assert_eq!(moved.revision, draft.revision);
    });
    phase("semantic", &root, &mut phases, || {
        store
            .upsert_node(
                &ids[0],
                draft.revision,
                node("Changed exactly one definition"),
            )
            .unwrap();
    });
    phase(
        "concurrent_distinct_definitions",
        &root,
        &mut phases,
        || {
            let barrier = Arc::new(Barrier::new(3));
            let mut threads = Vec::new();
            for id in ids.iter().skip(1).take(2) {
                let draft = store.read(id).unwrap();
                let cloned = store.clone();
                let gate = barrier.clone();
                threads.push(std::thread::spawn(move || {
                    gate.wait();
                    let clock = Instant::now();
                    let result = cloned
                        .upsert_node(
                            &draft.id,
                            draft.revision,
                            node("Concurrent single-definition edit"),
                        )
                        .unwrap();
                    (result.id, clock.elapsed().as_secs_f64() * 1000.)
                }));
            }
            barrier.wait();
            for thread in threads {
                let _ = thread.join().unwrap();
            }
        },
    );
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("library.lock"))
        .unwrap();
    lock.lock_exclusive().unwrap();
    let cloned = store.clone();
    FileExt::unlock(&lock).unwrap();
    let current = store.read(&ids[3]).unwrap();
    let draft = store
        .upsert_node(
            &current.id,
            current.revision,
            node("Changed draft for contended save"),
        )
        .unwrap();
    lock.lock_exclusive().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(()).unwrap();
        let start = now();
        let clock = Instant::now();
        let result = cloned.save(&draft.id, draft.revision);
        (result, clock.elapsed().as_secs_f64() * 1000., start, now())
    });
    rx.recv().unwrap();
    std::thread::sleep(Duration::from_millis(150));
    FileExt::unlock(&lock).unwrap();
    let (result, short_wait_ms, short_start, short_end) = worker.join().unwrap();
    assert_eq!(result.unwrap().saved_version, Some(13));
    assert!((125. ..2000.).contains(&short_wait_ms));
    let current = store.read(&ids[4]).unwrap();
    let draft = store
        .upsert_node(
            &current.id,
            current.revision,
            node("Changed draft for timed out save"),
        )
        .unwrap();
    let count = store.versions(&draft.id).unwrap().len();
    lock.lock_exclusive().unwrap();
    let clock = Instant::now();
    let timeout_start = now();
    let error = store.save(&draft.id, draft.revision).unwrap_err();
    let timeout_end = now();
    let timeout_ms = clock.elapsed().as_secs_f64() * 1000.;
    FileExt::unlock(&lock).unwrap();
    assert!(error.to_string().contains("workflow_busy"));
    assert!((2000. ..3000.).contains(&timeout_ms));
    assert_eq!(store.versions(&draft.id).unwrap().len(), count);
    let after = snapshot(&root);
    let immutable_unchanged = baseline
        .iter()
        .filter(|(key, _)| key.starts_with("objects/version-"))
        .all(|(key, value)| after.get(key) == Some(value));
    assert!(immutable_unchanged);
    assert_eq!(
        baseline
            .keys()
            .filter(|key| key.starts_with("objects/version-"))
            .count(),
        96
    );
    for phase in &phases {
        let changes = phase["changedFiles"].as_array().unwrap();
        let expected = if phase["phase"] == "concurrent_distinct_definitions" {
            3
        } else {
            2
        };
        assert_eq!(changes.len(), expected);
        assert!(changes.iter().all(|file| file["path"] == "storage.json"
            || file["path"].as_str().unwrap().starts_with("objects/draft-")));
    }
    let report = json!({"libraryRoot":root,"definitions":8,"versionsPerDefinition":12,"capacityBefore":capacity,"phases":phases,"baselineFiles":baseline,"immutableVersionsUnchanged":immutable_unchanged,"shortContentionMs":short_wait_ms,"shortSample":{"startUnix":short_start,"endUnix":short_end},"timeoutSample":{"startUnix":timeout_start,"endUnix":timeout_end},"timeoutContentionMs":timeout_ms,"timeoutSavedVersionCountUnchanged":true,"globalCatalogLockStillSerializesDefinitions":true});
    fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
