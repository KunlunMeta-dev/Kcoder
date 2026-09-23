use kcoder_test_harness::{WorkspaceFixture, workspace_root};
use std::path::PathBuf;

fn fixtures_root() -> PathBuf {
    workspace_root().unwrap().join("tests/fixtures")
}

#[test]
fn fixture_metadata_digest_and_materialization_are_deterministic() {
    let fixture = WorkspaceFixture::open(fixtures_root().join("minimal")).unwrap();
    let reopened = WorkspaceFixture::open(fixtures_root().join("minimal")).unwrap();
    assert_eq!(fixture.metadata().name, "minimal");
    assert_eq!(fixture.digest(), reopened.digest());
    assert_eq!(fixture.digest().len(), 64);

    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("workspace");
    let materialized = fixture.materialize(&destination).unwrap();
    assert_eq!(materialized.digest, fixture.digest());
    assert_eq!(
        std::fs::read_to_string(destination.join("README.txt")).unwrap(),
        "minimal fixture\n"
    );
}

#[test]
fn fixture_paths_reject_traversal_and_absolute_paths() {
    let fixture = WorkspaceFixture::open(fixtures_root().join("minimal")).unwrap();
    assert!(fixture.file_path("../outside").is_err());
    assert!(fixture.file_path("/absolute").is_err());
    assert!(fixture.file_path("README.txt").unwrap().is_file());
}

#[test]
fn materialization_refuses_to_overwrite_existing_destination() {
    let fixture = WorkspaceFixture::open(fixtures_root().join("minimal")).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("workspace");
    std::fs::create_dir(&destination).unwrap();
    std::fs::write(destination.join("owned.txt"), "preserve").unwrap();

    assert!(fixture.materialize(&destination).is_err());
    assert_eq!(
        std::fs::read_to_string(destination.join("owned.txt")).unwrap(),
        "preserve"
    );
}

#[test]
fn materialization_refuses_destination_inside_read_only_template() {
    let temporary = tempfile::tempdir().unwrap();
    std::fs::write(
        temporary.path().join("fixture.json"),
        r#"{"schema_version":1,"name":"source","version":"1","description":"test"}"#,
    )
    .unwrap();
    std::fs::write(temporary.path().join("source.txt"), "source").unwrap();
    let fixture = WorkspaceFixture::open(temporary.path()).unwrap();

    assert!(
        fixture
            .materialize(temporary.path().join("nested-copy"))
            .is_err()
    );
    assert!(!temporary.path().join("nested-copy").exists());
}

#[cfg(unix)]
#[test]
fn fixture_rejects_symlinks() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    std::fs::write(
        temporary.path().join("fixture.json"),
        r#"{"schema_version":1,"name":"linked","version":"1","description":"test"}"#,
    )
    .unwrap();
    symlink("fixture.json", temporary.path().join("linked.json")).unwrap();
    assert!(WorkspaceFixture::open(temporary.path()).is_err());
}

#[test]
fn fixture_rejects_generated_and_runtime_directories() {
    for forbidden in [
        "target",
        "node_modules",
        ".git",
        ".cache",
        "test-results",
        "playwright-report",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::write(
            temporary.path().join("fixture.json"),
            r#"{"schema_version":1,"name":"clean","version":"1","description":"test"}"#,
        )
        .unwrap();
        let generated = temporary.path().join("nested").join(forbidden);
        std::fs::create_dir_all(&generated).unwrap();
        std::fs::write(generated.join("pollution"), "runtime state").unwrap();

        let error = WorkspaceFixture::open(temporary.path()).unwrap_err();
        assert!(
            format!("{error:#}").contains("fixture 禁止包含生成或运行时目录"),
            "{forbidden} 返回了意外错误: {error:#}"
        );
    }
}

#[test]
fn fixture_allows_ordinary_files_named_like_generated_directories() {
    let temporary = tempfile::tempdir().unwrap();
    std::fs::write(
        temporary.path().join("fixture.json"),
        r#"{"schema_version":1,"name":"files","version":"1","description":"test"}"#,
    )
    .unwrap();
    for name in ["target", "node_modules", ".git", ".cache"] {
        std::fs::write(temporary.path().join(name), "ordinary fixture input").unwrap();
    }

    WorkspaceFixture::open(temporary.path()).unwrap();
}
