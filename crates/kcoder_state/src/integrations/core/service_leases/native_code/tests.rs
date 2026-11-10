//! Storage and kernel-lock regression only; no signed execution or worker is fabricated.
use super::*;
use kcoder_types::integrations::core::{
    IntegrationRevisionRef, NATIVE_CODE_SERVICE_TEMPLATE_V1, NativeCodeServiceTask,
};

#[test]
fn saved_code_restores_its_own_records_and_ignores_retired_channel_metadata() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("saved-code-retired-channel-records")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let scope: IntegrationScope = serde_json::from_value(serde_json::json!({
        "accountId":"owner", "targetId":"target", "workspaceId":"workspace",
        "identityGeneration":"identity", "targetRevision":"configuration"
    }))?;
    let store = IntegrationServiceLeaseStore::create_in(&parent, OsStr::new("services"), &scope)?;
    let retired_names = [
        format!("channel-source-{}.json", "1".repeat(64)),
        format!("channel-enabled-{}.json", "1".repeat(64)),
        format!("lease-{}.json", "1".repeat(64)),
    ];
    for name in &retired_names {
        store
            .directory
            .atomic_replace(OsStr::new(name), b"retired-metadata")?;
    }
    let task = NativeCodeServiceTask {
        definition_id: "saved-definition".into(),
        version: 1,
        definition_sha256: "a".repeat(64),
        args: serde_json::json!({}),
        runtime_operation_id: "saved-code-runtime".into(),
    };
    let intent = NativeCodeServiceIntent {
        template: NATIVE_CODE_SERVICE_TEMPLATE_V1.into(),
        lease_id: "saved-code".into(),
        operation_id: "approve-code".into(),
        scope: scope.clone(),
        definition_id: task.definition_id.clone(),
        definition_version: task.version,
        definition_sha256: task.definition_sha256.clone(),
        task_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&task)?)),
        configuration_sha256: "b".repeat(64),
        native_image_sha256: "c".repeat(64),
        expires_at_ms: 10000,
    };
    let launch = NativeCodeServiceLaunchSpec {
        schema_version: 1,
        lease_id: intent.lease_id.clone(),
        profile_path: root.path().join("profile"),
        workspace_path: root.path().join("workspace"),
        settings_file: root.path().join("profile/settings.json"),
        task,
    };
    store.prepare_native_code(&intent, &launch)?;
    let record = NativeCodeServiceRecord {
        schema_version: 1,
        revision: 1,
        intent,
        grant_ref: IntegrationRevisionRef {
            id: "original-code-grant".into(),
            revision: "1".into(),
        },
        state: NativeCodeServiceState::Approved,
        enabled: true,
        observed_at_ms: 100,
    };
    store.commit_native_code(record.clone())?;
    let owner = store
        .claim_native_code_owner("saved-code")?
        .context("original code owner")?;
    let reopened = IntegrationServiceLeaseStore::open_in(&parent, OsStr::new("services"), &scope)?;
    assert_eq!(
        reopened.read_native_code("saved-code")?,
        Some(record.clone())
    );
    assert_eq!(serde_json::to_value(&record)?["state"], "approved");
    assert!(reopened.claim_native_code_owner("saved-code")?.is_none());
    assert_eq!(reopened.list_native_code()?.len(), 1);
    assert!(reopened.read_native_code_launch("saved-code")? == launch);
    let running =
        reopened.transition_native_code("saved-code", 1, NativeCodeServiceState::Running, 200)?;
    assert!(
        store
            .transition_native_code("saved-code", 1, NativeCodeServiceState::Stopped, 201)
            .is_err()
    );
    drop(owner);
    let revoked = store.transition_native_code(
        "saved-code",
        running.revision,
        NativeCodeServiceState::Revoked,
        300,
    )?;
    assert!(!revoked.enabled);
    assert!(reopened.claim_native_code_owner("saved-code").is_err());
    assert!(
        reopened
            .set_native_code_enabled("saved-code", revoked.revision, true, 301)
            .is_err()
    );
    for name in retired_names {
        assert_eq!(
            std::fs::read(root.path().join("services").join(name))?,
            b"retired-metadata"
        );
    }
    Ok(())
}
