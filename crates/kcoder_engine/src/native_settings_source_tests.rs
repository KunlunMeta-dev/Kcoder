//! A readable native source is separate from writable settings and Office authority.
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
#[tokio::test]
async fn readonly_child_source_cannot_write_settings_or_enable_office_tools() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let original = b"{\"model\":\"owner-original\"}";
    std::fs::write(&path, original).unwrap();
    let parent = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_settings_persistence_path(path.clone());
    let child = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_native_readonly_settings_source_from(&parent)
        .unwrap();
    assert_eq!(child.native_settings_source_path(), Some(path.clone()));
    assert_eq!(child.settings_persistence_path(), None);
    assert_eq!(parent.settings_persistence_path(), Some(path.clone()));
    let mut changed = child.settings.read().unwrap().clone();
    changed.model = "unauthorized-change".into();
    assert!(
        child
            .persist_settings_fields(changed, &["model"])
            .await
            .is_err()
    );
    assert!(child.persist_allowed_tool("bash").await.is_err());
    assert!(child.persist_denied_tool("read").await.is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!child.native_core_workflow_office_child_allowed());
    assert!(child.active_tool_registry().get("tool_search").is_none());
    assert!(child.active_tool_registry().get("OfficeDocument").is_none());
}
#[test]
fn missing_parent_source_is_unavailable_without_inventing_a_profile() {
    let root = tempfile::tempdir().unwrap();
    let mut parent = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    parent.settings_persistence_target = Arc::new(RwLock::new(SettingsPersistenceTarget::Disabled));
    let child = TestEngineBuilder::new(root.path()).build_with_profile_directory();
    assert!(
        child
            .with_native_readonly_settings_source_from(&parent)
            .is_err()
    );
}
