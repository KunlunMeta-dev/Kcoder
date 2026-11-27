use super::*;
use std::ffi::OsStr;

fn owned() -> (tempfile::TempDir, PeerMessagePolicy) {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    let paths = ConfigPaths::with_config_dir_and_executable_dir(root.path(), profile, None);
    let policy = PeerMessagePolicy::capture(paths).unwrap();
    (root, policy)
}

#[test]
fn read_is_pure_and_project_configuration_does_not_enable_account_policy() {
    let (root, policy) = owned();
    let project = root.path().join(".kcoder");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(
        project.join("settings.json"),
        br#"{"cross_session_messages":{"enabled":true,"wake_idle":true}}"#,
    )
    .unwrap();
    let observation = policy.read().unwrap();
    assert!(!observation.enabled);
    assert!(!observation.wake_idle);
    assert!(!policy.paths.user_settings.exists());
    assert!(
        std::fs::read_dir(&policy.paths.config_dir)
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn explicit_user_save_uses_revision_preserves_other_settings_and_observes_revocation() {
    let (_root, policy) = owned();
    policy
        .profile
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"default_subagent_max_turns":80,"cross_session_messages":{"enabled":false,"message_ttl_seconds":42,"max_messages_per_minute":7,"max_source_messages_per_minute":3}}"#,
        )
        .unwrap();
    let original = policy.read().unwrap();
    let enabled = policy.save(&original.revision, true, true).unwrap();
    assert!(enabled.enabled && enabled.wake_idle);
    assert_ne!(enabled.revision, original.revision);
    assert!(policy.save(&original.revision, false, false).is_err());
    let value = read_scope(&policy.paths, ConfigScope::User).unwrap();
    assert_eq!(value["default_subagent_max_turns"], 80);
    let limits = policy.read_settings().unwrap();
    assert_eq!(limits.message_ttl_seconds, 42);
    assert_eq!(limits.max_messages_per_minute, 7);
    assert_eq!(limits.max_source_messages_per_minute, 3);
    let disabled = policy.save(&enabled.revision, false, false).unwrap();
    assert_eq!(policy.read().unwrap(), disabled);
    assert!(!disabled.enabled);
}

#[test]
fn damaged_policy_and_replaced_profile_fail_without_repair() {
    let (root, policy) = owned();
    policy
        .profile
        .atomic_replace(OsStr::new("settings.json"), b"{")
        .unwrap();
    assert!(policy.read().is_err());
    assert_eq!(std::fs::read(&policy.paths.user_settings).unwrap(), b"{");
    std::fs::rename(
        &policy.paths.config_dir,
        root.path().join("original-profile"),
    )
    .unwrap();
    PrivateDirectory::open_or_create(&policy.paths.config_dir).unwrap();
    assert!(policy.read().is_err());
    assert!(!policy.paths.user_settings.exists());
}
