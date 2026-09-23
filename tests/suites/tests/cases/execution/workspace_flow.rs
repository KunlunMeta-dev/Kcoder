use std::path::PathBuf;
use std::process::Command;

use kcoder_engine::checkpoint::CheckpointManager;
use kcoder_state::AppState;
use kcoder_test_harness::{WorkspaceFixture, workspace_root};

#[test]
fn materialized_rust_workspace_survives_state_binding_checkpoint_rewind_and_cargo_check() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let fixture = WorkspaceFixture::open(fixture_root("rust-project"))
        .expect("rust project fixture should open");
    let materialized = fixture
        .materialize(temporary.path().join("workspace"))
        .expect("fixture should materialize");
    assert_eq!(materialized.metadata.name, "rust-project");
    assert_eq!(materialized.digest, fixture.digest());

    let state = AppState::new(&materialized.root);
    assert_eq!(state.cwd(), materialized.root);

    let source = state.cwd().join("src/lib.rs");
    let original = std::fs::read_to_string(&source).expect("fixture source should be readable");
    let checkpoints = CheckpointManager::new(temporary.path().join("session"));
    checkpoints.snapshot_before_write(1, &source);
    std::fs::write(&source, "this is not valid Rust").expect("fixture mutation should be written");

    let rewind = checkpoints.rewind(1).expect("checkpoint should rewind");
    assert_eq!(rewind.restored, vec![source.clone()]);
    assert!(rewind.deleted.is_empty());
    assert!(rewind.failed.is_empty());
    assert_eq!(
        std::fs::read_to_string(&source).expect("restored source should be readable"),
        original
    );

    let output = Command::new("cargo")
        .args(["check", "--offline", "--quiet"])
        .current_dir(&materialized.root)
        .env("CARGO_TARGET_DIR", temporary.path().join("target"))
        .output()
        .expect("cargo should run for the fixture");
    assert!(
        output.status.success(),
        "restored fixture did not compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixture_root(name: &str) -> PathBuf {
    workspace_root()
        .expect("应解析当前 KCoder 工作区")
        .join("tests/fixtures")
        .join(name)
}
