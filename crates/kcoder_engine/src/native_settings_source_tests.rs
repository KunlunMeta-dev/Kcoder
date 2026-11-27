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

#[tokio::test]
async fn selected_profile_readonly_child_tools_keep_the_parent_skill_source() {
    use kcoder_tools::Tool;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("parent-profile");
    let skills = profile.join("skills/profile-demo");
    std::fs::create_dir_all(&skills).unwrap();
    std::fs::write(
        skills.join("SKILL.md"),
        "---\nname: profile-demo\ndescription: Parent profile only\n---\nFixture.\n",
    )
    .unwrap();
    kcoder_tools::skill_provenance::record_hub_installed_at(
        &profile.join("skills"),
        "profile-demo",
        "https://fixture.invalid/profile-demo",
    );
    let settings = profile.join("settings.json");
    std::fs::write(&settings, b"{}").unwrap();
    let parent = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_settings_persistence_path(settings.clone());
    let child = TestEngineBuilder::new(root.path())
        .build_with_profile_directory()
        .with_native_readonly_settings_source_from(&parent)
        .unwrap();
    let context = child.base_tool_context(1024, 1024, 0, None);
    let output = kcoder_tools::SkillHubTool
        .call(
            serde_json::json!({"action": "list", "scope": "user"}),
            &context,
        )
        .await
        .unwrap();
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(text.contains("profile-demo"), "{text}");
    assert_eq!(child.settings_persistence_path(), None);
    assert_eq!(std::fs::read(settings).unwrap(), b"{}");
}
