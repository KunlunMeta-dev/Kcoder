//! Actual runner evidence must record source state on both sides of a suite.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args(args)
        .current_dir(root)
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn fixture(mode: &str) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("tests/harness")).unwrap();
    fs::write(root.join("Cargo.toml"), "[workspace]\n").unwrap();
    fs::write(
        root.join("tests/harness/Cargo.toml"),
        "[package]\nname='fixture'\nversion='0.0.0'\n",
    )
    .unwrap();
    fs::write(root.join(".gitignore"), "target/\n").unwrap();
    fs::write(root.join("marker.txt"), "original\n").unwrap();
    fs::write(
        root.join("scenario.py"),
        include_str!("fixtures/source_observation.py"),
    )
    .unwrap();
    fs::write(root.join("tests/matrix.toml"), format!(
        "schema_version=2\n[[suite]]\nid='source-proof'\ntiers=['pr']\ncommand=['python3','scenario.py','{{artifact_dir}}','{mode}']\nsummary={{parser='assertions-json',expected_skips=0}}\nrequired_artifacts=['assertions.json']\n"
    )).unwrap();
    git(root, &["init", "-q"]);
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
    );
    temp
}

fn run(root: &Path) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_kcoder_test_runner"))
        .current_dir(root)
        .args(["--tier", "pr", "--suite", "source-proof"])
        .env("KCODER_WORKSPACE_ROOT", root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let base = root.join("target/test-runs/project");
    let mut runs = fs::read_dir(base)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<PathBuf>>();
    assert_eq!(runs.len(), 1);
    let execution = runs
        .pop()
        .unwrap()
        .join("cases/source-proof/execution.json");
    serde_json::from_slice(&fs::read(execution).unwrap()).unwrap()
}

#[test]
fn actual_runner_records_clean_dirty_and_changed_source_boundaries() {
    let clean = fixture("clean");
    let head = git(clean.path(), &["rev-parse", "HEAD"]);
    let evidence = run(clean.path());
    for key in ["source_before", "source_after"] {
        assert_eq!(evidence[key]["git_commit"], head);
        assert_eq!(evidence[key]["clean"], true);
    }

    let dirty = fixture("clean");
    fs::write(dirty.path().join("marker.txt"), "dirty before suite\n").unwrap();
    let evidence = run(dirty.path());
    assert_eq!(evidence["source_before"]["clean"], false);
    assert_eq!(evidence["source_after"]["clean"], false);

    let changed = fixture("mutate");
    let evidence = run(changed.path());
    assert_eq!(evidence["source_before"]["clean"], true);
    assert_eq!(evidence["source_after"]["clean"], false);
}
