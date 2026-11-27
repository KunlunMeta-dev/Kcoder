use kcoder_test_harness::{MaterializedFixture, WorkspaceFixture, workspace_root};
use tempfile::TempDir;

fn materialize_extensions_fixture() -> (TempDir, MaterializedFixture) {
    let fixture_root = workspace_root()
        .expect("应解析当前 KCoder 工作区")
        .join("tests/fixtures/extensions-project");
    let fixture = WorkspaceFixture::open(fixture_root).expect("extensions fixture 应合法");
    assert_eq!(fixture.metadata().name, "extensions-project");
    let temporary = TempDir::new().expect("应创建临时 fixture 根");
    let materialized = fixture
        .materialize(temporary.path().join("workspace"))
        .expect("应物化 extensions fixture");
    (temporary, materialized)
}

#[path = "cases/extensions/registries.rs"]
mod registries;
#[path = "cases/extensions/specs.rs"]
mod specs;
#[path = "cases/extensions/workflow.rs"]
mod workflow;
