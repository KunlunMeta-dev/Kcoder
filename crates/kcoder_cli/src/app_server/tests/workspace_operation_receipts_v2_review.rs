#[cfg(target_os = "linux")]
fn workspace_operation_receipts_v2_review_request(
    method: &str,
    context: &kcoder_app_protocol::TrustedRetentionContextV1,
    target_id: &str,
    account: Option<kcoder_app_protocol::WorkspaceParentAccountV2>,
    params: Value,
) -> kcoder_app_protocol::PrivateRetentionRequestV1 {
    let mut extension = json!({
        "version": 1,
        "context": context,
        "workspaceTargetId": target_id,
    });
    if let Some(account) = account {
        extension["workspaceAccount"] = serde_json::to_value(account).unwrap();
    }
    serde_json::from_value(json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": method,
        "params": params,
        "kcoderPrivateRetention": extension,
    }))
    .expect("construct typed private V2 workspace request")
}

#[cfg(target_os = "linux")]
fn workspace_operation_receipts_v2_review_authority(
    engine: &QueryEngine,
    account_root: &std::path::Path,
    parent: kcoder_app_protocol::RetentionParentLaunchV1,
) -> super::retention_context::VerifiedRetentionAuthority {
    super::retention_context::VerifiedRetentionAuthority::capture(
        super::retention_context::RetentionLaunchConfiguration {
            parent,
            account_root: account_root.to_path_buf(),
            optional: false,
        },
        engine,
    )
    .expect("capture real V2 workspace receipt authority")
}

#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_scope(
    authority: &super::retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    context: &kcoder_app_protocol::TrustedRetentionContextV1,
    target_id: &str,
    account: Option<kcoder_app_protocol::WorkspaceParentAccountV2>,
) -> Value {
    let request = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
        context,
        target_id,
        account,
        json!({}),
    );
    super::workspace_operation_receipts_v2::dispatch(authority, engine, &request)
        .await
        .expect("scopeV2 succeeds for captured trusted authority")
}

#[cfg(target_os = "linux")]
fn workspace_operation_receipts_v2_review_parent_account(
    principal_id: &str,
) -> kcoder_app_protocol::RetentionParentLaunchV1 {
    kcoder_app_protocol::RetentionParentLaunchV1::VerifiedAccount {
        principal_id: principal_id.to_string(),
        uid: unsafe { libc::geteuid() },
    }
}

#[cfg(target_os = "linux")]
fn workspace_operation_receipts_v2_review_workspace_account(
    role: &str,
    authorization_generation: &str,
) -> kcoder_app_protocol::WorkspaceParentAccountV2 {
    kcoder_app_protocol::WorkspaceParentAccountV2 {
        role: role.to_string(),
        authorization_generation: authorization_generation.to_string(),
    }
}

#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_assert_known_id_conflict(
    authority: &super::retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    account_root: &std::path::Path,
    context: &kcoder_app_protocol::TrustedRetentionContextV1,
    target_id: &str,
    account: Option<kcoder_app_protocol::WorkspaceParentAccountV2>,
    request_id: &str,
    scope_id: &str,
    ready_path: &std::path::Path,
) {
    let ledger = account_root.join("workspace-operations-v2");
    let before = workspace_operation_receipts_v2_review_file_snapshot(&ledger);
    let request = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        context,
        target_id,
        account,
        json!({
            "clientRequestId": request_id,
            "scopeId": scope_id,
        }),
    );
    let error = super::workspace_operation_receipts_v2::dispatch(authority, engine, &request)
        .await
        .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&error),
        -32001,
        "a known ID under another trusted scope is a conflict"
    );
    assert!(
        !format!("{error:#}").contains(ready_path.to_str().unwrap()),
        "scope conflict must not disclose the ready path"
    );
    assert_eq!(
        workspace_operation_receipts_v2_review_file_snapshot(&ledger),
        before,
        "conflicting lookup leaves the durable receipt bytes unchanged"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_scope_binds_trusted_target_and_local_context() {
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    let other_workspace = fixture.path().join("other-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other_workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let context = retention_context_review_local_context();
    let target_id = "stored-server-target";
    let base = workspace_operation_receipts_v2_review_scope(
        &authority, &engine, &context, target_id, None,
    )
    .await;
    assert_eq!(base["version"], 2);
    assert_eq!(
        base,
        workspace_operation_receipts_v2_review_scope(
            &authority, &engine, &context, target_id, None,
        )
        .await,
        "the same captured root and trusted tuple produce a stable scope"
    );

    let mut changed_device = context.clone();
    changed_device.device_id = "different-mobile-device".into();
    let mut changed_generation = context.clone();
    changed_generation.authorization_generation = "review-auth-generation-2".into();
    let mut changed_gateway = context.clone();
    changed_gateway.gateway_namespace_id = "different-install-namespace".into();
    let mut changed_target_fingerprint = context.clone();
    changed_target_fingerprint.target_fingerprint = "different-target-fingerprint".into();

    for (label, changed) in [
        ("device", changed_device),
        ("authorization generation", changed_generation),
        ("gateway namespace", changed_gateway),
        ("target fingerprint", changed_target_fingerprint),
    ] {
        let scoped = workspace_operation_receipts_v2_review_scope(
            &authority, &engine, &changed, target_id, None,
        )
        .await;
        assert_eq!(
            scoped["rootId"], base["rootId"],
            "{label} does not change root"
        );
        assert_ne!(
            scoped["scopeId"], base["scopeId"],
            "{label} must bind the scope"
        );
    }

    let changed_target = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "another-stored-target",
        None,
    )
    .await;
    assert_eq!(changed_target["rootId"], base["rootId"]);
    assert_ne!(
        changed_target["scopeId"], base["scopeId"],
        "the selected stored target is part of scope identity"
    );

    let other_engine = retention_context_review_engine(&other_workspace);
    let other_authority = workspace_operation_receipts_v2_review_authority(
        &other_engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let other_root = workspace_operation_receipts_v2_review_scope(
        &other_authority,
        &other_engine,
        &context,
        target_id,
        None,
    )
    .await;
    assert_ne!(
        other_root["rootId"], base["rootId"],
        "a different captured engine cwd has a different root identity"
    );
    assert_ne!(other_root["scopeId"], base["scopeId"]);
    assert!(
        !account_root.join("workspace-operations-v2").exists(),
        "scope discovery alone must not create the durable receipt ledger"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_account_scope_binds_principal_role_and_generation()
{
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("review-account"),
    );
    let context = retention_context_review_account_context("review-account");
    let account = workspace_operation_receipts_v2_review_workspace_account("owner", "17");
    let base = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "stored-server-target",
        Some(account.clone()),
    )
    .await;
    let request_id = "v2-account-scope-known-id";
    let ready_path = workspace.join("account-scoped-ready");
    let create = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
        &context,
        "stored-server-target",
        Some(account.clone()),
        json!({
            "clientRequestId": request_id,
            "scopeId": base["scopeId"],
            "workspacePath": ready_path.to_string_lossy(),
            "action": "create",
        }),
    );
    let created = super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &create)
        .await
        .unwrap();
    assert!(ready_path.is_dir());
    assert_eq!(created["receipt"]["status"], "ready");
    assert_eq!(
        created["result"]["mapping"]["deviceId"],
        "stored-server-target"
    );

    let changed_role = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "stored-server-target",
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "member", "17",
        )),
    )
    .await;
    assert_eq!(changed_role["rootId"], base["rootId"]);
    assert_ne!(
        changed_role["scopeId"], base["scopeId"],
        "account role is an independent scope dimension"
    );
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &authority,
        &engine,
        &account_root,
        &context,
        "stored-server-target",
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "member", "17",
        )),
        request_id,
        changed_role["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;

    let changed_account_generation = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "stored-server-target",
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "owner", "18",
        )),
    )
    .await;
    assert_eq!(changed_account_generation["rootId"], base["rootId"]);
    assert_ne!(
        changed_account_generation["scopeId"], base["scopeId"],
        "account authorization generation is an independent scope dimension"
    );
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &authority,
        &engine,
        &account_root,
        &context,
        "stored-server-target",
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "owner", "18",
        )),
        request_id,
        changed_account_generation["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;

    let mut changed_context_generation_context = context.clone();
    changed_context_generation_context.authorization_generation = "review-auth-generation-2".into();
    let changed_context_generation_scope = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &changed_context_generation_context,
        "stored-server-target",
        Some(account.clone()),
    )
    .await;
    assert_eq!(changed_context_generation_scope["rootId"], base["rootId"]);
    assert_ne!(changed_context_generation_scope["scopeId"], base["scopeId"]);
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &authority,
        &engine,
        &account_root,
        &changed_context_generation_context,
        "stored-server-target",
        Some(account.clone()),
        request_id,
        changed_context_generation_scope["scopeId"]
            .as_str()
            .unwrap(),
        &ready_path,
    )
    .await;

    let mut changed_device_context = context.clone();
    changed_device_context.device_id = "other-mobile-device".into();
    let changed_device_scope = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &changed_device_context,
        "stored-server-target",
        Some(account.clone()),
    )
    .await;
    assert_eq!(changed_device_scope["rootId"], base["rootId"]);
    assert_ne!(changed_device_scope["scopeId"], base["scopeId"]);
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &authority,
        &engine,
        &account_root,
        &changed_device_context,
        "stored-server-target",
        Some(account.clone()),
        request_id,
        changed_device_scope["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;

    let changed_target = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "different-stored-target",
        Some(account.clone()),
    )
    .await;
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &authority,
        &engine,
        &account_root,
        &context,
        "different-stored-target",
        Some(account.clone()),
        request_id,
        changed_target["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;

    let other_principal_authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("other-account"),
    );
    let other_principal_context = retention_context_review_account_context("other-account");
    let other_principal = workspace_operation_receipts_v2_review_scope(
        &other_principal_authority,
        &engine,
        &other_principal_context,
        "stored-server-target",
        Some(account.clone()),
    )
    .await;
    assert_eq!(other_principal["rootId"], base["rootId"]);
    assert_ne!(
        other_principal["scopeId"], base["scopeId"],
        "a separately verified principal has a distinct receipt scope"
    );
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &other_principal_authority,
        &engine,
        &account_root,
        &other_principal_context,
        "stored-server-target",
        Some(account.clone()),
        request_id,
        other_principal["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;

    let other_workspace = fixture.path().join("other-workspace");
    std::fs::create_dir_all(&other_workspace).unwrap();
    let other_engine = retention_context_review_engine(&other_workspace);
    let other_root_authority = workspace_operation_receipts_v2_review_authority(
        &other_engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("review-account"),
    );
    let other_root_scope = workspace_operation_receipts_v2_review_scope(
        &other_root_authority,
        &other_engine,
        &context,
        "stored-server-target",
        Some(account),
    )
    .await;
    assert_ne!(other_root_scope["rootId"], base["rootId"]);
    workspace_operation_receipts_v2_review_assert_known_id_conflict(
        &other_root_authority,
        &other_engine,
        &account_root,
        &context,
        "stored-server-target",
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "owner", "17",
        )),
        request_id,
        other_root_scope["scopeId"].as_str().unwrap(),
        &ready_path,
    )
    .await;
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_family_fences_namespace_and_target_only() {
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    let other_workspace = fixture.path().join("other-default-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other_workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("family-review-account"),
    );
    let context = retention_context_review_account_context("family-review-account");
    let account = workspace_operation_receipts_v2_review_workspace_account("owner", "17");
    let target_id = "stored-family-target";
    let base = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        target_id,
        Some(account.clone()),
    )
    .await;
    let family_id = base["familyId"].as_str().unwrap();
    assert_eq!(family_id.len(), 64, "family ID is a SHA-256 digest");

    let mut changed_alias_fingerprint = context.clone();
    changed_alias_fingerprint.target_fingerprint = "different-alias-or-default-target".into();
    let alias = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &changed_alias_fingerprint,
        target_id,
        Some(account.clone()),
    )
    .await;
    assert_eq!(alias["familyId"], family_id);
    assert_ne!(alias["scopeId"], base["scopeId"]);

    let mut changed_device = context.clone();
    changed_device.device_id = "different-mobile-device".into();
    let device = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &changed_device,
        target_id,
        Some(account.clone()),
    )
    .await;
    assert_eq!(device["familyId"], family_id);
    assert_ne!(device["scopeId"], base["scopeId"]);

    let changed_account = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        target_id,
        Some(workspace_operation_receipts_v2_review_workspace_account(
            "member", "18",
        )),
    )
    .await;
    assert_eq!(changed_account["familyId"], family_id);
    assert_ne!(changed_account["scopeId"], base["scopeId"]);

    let changed_principal_authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("other-family-account"),
    );
    let changed_principal_context =
        retention_context_review_account_context("other-family-account");
    let changed_principal = workspace_operation_receipts_v2_review_scope(
        &changed_principal_authority,
        &engine,
        &changed_principal_context,
        target_id,
        Some(account.clone()),
    )
    .await;
    assert_eq!(changed_principal["familyId"], family_id);
    assert_ne!(changed_principal["scopeId"], base["scopeId"]);

    let other_engine = retention_context_review_engine(&other_workspace);
    let other_authority = workspace_operation_receipts_v2_review_authority(
        &other_engine,
        &account_root,
        workspace_operation_receipts_v2_review_parent_account("family-review-account"),
    );
    let other_default_root = workspace_operation_receipts_v2_review_scope(
        &other_authority,
        &other_engine,
        &context,
        target_id,
        Some(account.clone()),
    )
    .await;
    assert_ne!(other_default_root["rootId"], base["rootId"]);
    assert_eq!(other_default_root["familyId"], family_id);
    assert_ne!(other_default_root["scopeId"], base["scopeId"]);

    let mut changed_namespace_context = context.clone();
    changed_namespace_context.gateway_namespace_id = "different-gateway-install".into();
    let changed_namespace = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &changed_namespace_context,
        target_id,
        Some(account.clone()),
    )
    .await;
    assert_ne!(changed_namespace["familyId"], family_id);
    assert_ne!(changed_namespace["scopeId"], base["scopeId"]);

    let changed_target = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &context,
        "different-stored-family-target",
        Some(account),
    )
    .await;
    assert_ne!(changed_target["familyId"], family_id);
    assert_ne!(changed_target["scopeId"], base["scopeId"]);
}

#[cfg(target_os = "linux")]
fn workspace_operation_receipts_v2_review_file_snapshot(
    root: &std::path::Path,
) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    fn visit(
        root: &std::path::Path,
        current: &std::path::Path,
        files: &mut std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
    ) {
        for entry in std::fs::read_dir(current).unwrap() {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_dir() {
                visit(root, &path, files);
            } else {
                assert!(
                    metadata.file_type().is_file(),
                    "unexpected symlink or special file under {path:?}"
                );
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }

    let mut files = std::collections::BTreeMap::new();
    if root.is_dir() {
        visit(root, root, &mut files);
    }
    files
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_ready_replay_is_exact_and_v1_is_untouched() {
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let context = retention_context_review_local_context();
    let target_id = "stored-server-target";
    let authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let scope = workspace_operation_receipts_v2_review_scope(
        &authority, &engine, &context, target_id, None,
    )
    .await;
    let scope_id = scope["scopeId"].as_str().unwrap();
    let request_id = "v2-ready-shared-id";
    let missing_read = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "not-created-yet",
            "scopeId": scope_id,
        }),
    );
    let missing =
        super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &missing_read)
            .await
            .unwrap();
    assert!(
        missing["receipt"].is_null(),
        "only a missing ID under the exact captured scope is reported as absent"
    );
    let ledger = account_root.join("workspace-operations-v2");
    assert!(
        !ledger.exists(),
        "a missing read does not create the ledger"
    );

    let target = workspace.join("created-by-v2");
    let mutation = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": request_id,
            "scopeId": scope_id,
            "workspacePath": target.to_string_lossy(),
            "action": "create",
            "label": "V2 project",
        }),
    );
    let first = super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &mutation)
        .await
        .unwrap();
    assert!(target.is_dir());
    assert_eq!(first["receipt"]["status"], "ready");
    assert_eq!(
        first["receipt"]["workspacePath"],
        target.to_string_lossy().as_ref()
    );
    assert_eq!(
        first["result"]["mapping"]["deviceId"], target_id,
        "registry routing uses the trusted stored target ID, not the Mobile device ID"
    );
    assert_ne!(
        first["result"]["mapping"]["deviceId"], context.device_id,
        "the device authority dimension is not reversed into registry routing"
    );
    assert_eq!(
        std::fs::read_dir(&ledger)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .count(),
        1
    );

    let replay = super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &mutation)
        .await
        .unwrap();
    assert_eq!(
        replay, first,
        "exact replay returns the immutable original result"
    );
    let quota: Value =
        serde_json::from_slice(&std::fs::read(ledger.join("quota")).unwrap()).unwrap();
    assert_eq!(quota["version"], 2);
    assert_eq!(quota["reserved"], 1, "replay does not reserve another slot");

    let wrong_expected_scope = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": request_id,
            "scopeId": "0000000000000000000000000000000000000000000000000000000000000000",
        }),
    );
    let wrong_scope_error = super::workspace_operation_receipts_v2::dispatch(
        &authority,
        &engine,
        &wrong_expected_scope,
    )
    .await
    .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&wrong_scope_error),
        -32001
    );

    let mut other_device_context = context.clone();
    other_device_context.device_id = "new-mobile-device".into();
    let other_device_scope = workspace_operation_receipts_v2_review_scope(
        &authority,
        &engine,
        &other_device_context,
        target_id,
        None,
    )
    .await;
    let cross_scope_read = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &other_device_context,
        target_id,
        None,
        json!({
            "clientRequestId": request_id,
            "scopeId": other_device_scope["scopeId"],
        }),
    );
    let cross_scope_error =
        super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &cross_scope_read)
            .await
            .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&cross_scope_error),
        -32001,
        "a known ID in another scope is a conflict, never an absent receipt"
    );
    assert!(
        !format!("{cross_scope_error:#}").contains(target.to_str().unwrap()),
        "scope conflicts must not leak the registered path"
    );

    let invalid_public_field = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "invalid-public-device-field",
            "scopeId": scope_id,
            "workspacePath": workspace.join("must-not-exist").to_string_lossy(),
            "action": "create",
            "deviceId": "untrusted-public-value",
        }),
    );
    let invalid_error = super::workspace_operation_receipts_v2::dispatch(
        &authority,
        &engine,
        &invalid_public_field,
    )
    .await
    .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&invalid_error),
        -32031
    );
    assert!(!workspace.join("must-not-exist").exists());
    let invalid_id_read = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "invalid-public-device-field",
            "scopeId": scope_id,
        }),
    );
    let invalid_id_receipt =
        super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &invalid_id_read)
            .await
            .unwrap();
    assert!(
        invalid_id_receipt["receipt"].is_null(),
        "strict parameter rejection happens before reserving the public request ID"
    );

    // A pre-existing V1 record with the same ID is not a V2 receipt source.
    let legacy_target = workspace.join("legacy-v1-project");
    workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &json!({
            "workspacePath": legacy_target.to_string_lossy(),
            "clientRequestId": request_id,
            "deviceId": "legacy-device",
            "action": "create",
        }),
    )
    .await
    .unwrap();
    assert!(legacy_target.is_dir());
    let legacy_only_target = workspace.join("legacy-only-v1-project");
    workspace_request(
        &engine,
        "runtime.workspaces.prepare",
        &json!({
            "workspacePath": legacy_only_target.to_string_lossy(),
            "clientRequestId": "legacy-only-id",
            "deviceId": "legacy-device",
            "action": "create",
        }),
    )
    .await
    .unwrap();
    assert!(legacy_only_target.is_dir());
    let v1_directory = engine.client_storage_root().join("workspace-operations");
    let v1_baseline = workspace_operation_receipts_v2_review_file_snapshot(&v1_directory);

    let reopened_engine = retention_context_review_engine(&workspace);
    let reopened_authority = workspace_operation_receipts_v2_review_authority(
        &reopened_engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let reopened_read = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": request_id,
            "scopeId": scope_id,
        }),
    );
    let recovered = super::workspace_operation_receipts_v2::dispatch(
        &reopened_authority,
        &reopened_engine,
        &reopened_read,
    )
    .await
    .unwrap();
    assert_eq!(recovered["receipt"]["status"], "ready");
    assert_eq!(
        recovered["receipt"]["workspacePath"],
        target.to_string_lossy().as_ref(),
        "reopen recovers only the account-root V2 result"
    );
    let v1_only_read = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "legacy-only-id",
            "scopeId": scope_id,
        }),
    );
    let not_migrated = super::workspace_operation_receipts_v2::dispatch(
        &reopened_authority,
        &reopened_engine,
        &v1_only_read,
    )
    .await
    .unwrap();
    assert!(
        not_migrated["receipt"].is_null(),
        "a V1-only identity is not silently migrated or read as V2"
    );
    assert_eq!(
        workspace_operation_receipts_v2_review_file_snapshot(&v1_directory),
        v1_baseline,
        "V2 read/recovery does not modify the legacy V1 namespace"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_unknown_reservation_is_permanent_and_bounded() {
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let blocker = workspace.join("not-a-directory");
    std::fs::write(&blocker, b"keep this existing file").unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let context = retention_context_review_local_context();
    let target_id = "stored-server-target";
    let authority = workspace_operation_receipts_v2_review_authority(
        &engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let scope = workspace_operation_receipts_v2_review_scope(
        &authority, &engine, &context, target_id, None,
    )
    .await;
    let scope_id = scope["scopeId"].as_str().unwrap();
    let blocked_path = blocker.join("child");
    let blocked_request = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "v2-unknown-reserved-id",
            "scopeId": scope_id,
            "workspacePath": blocked_path.to_string_lossy(),
            "action": "create",
        }),
    );

    let first_error = super::workspace_operation_receipts_v2::dispatch_with_receipt_limit(
        &authority,
        &engine,
        &blocked_request,
        1,
    )
    .await
    .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&first_error),
        -32031,
        "a real mkdir failure after reservation has an unknown completion"
    );
    assert!(blocker.is_file());
    assert!(!blocked_path.exists());

    let ledger = account_root.join("workspace-operations-v2");
    let quota: Value =
        serde_json::from_slice(&std::fs::read(ledger.join("quota")).unwrap()).unwrap();
    assert_eq!(quota["reserved"], 1);
    let read_unknown = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "v2-unknown-reserved-id",
            "scopeId": scope_id,
        }),
    );
    let unknown =
        super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &read_unknown)
            .await
            .unwrap();
    assert_eq!(unknown["receipt"]["status"], "unknown");
    assert!(unknown["receipt"]["workspacePath"].is_null());

    let retry_error =
        super::workspace_operation_receipts_v2::dispatch(&authority, &engine, &blocked_request)
            .await
            .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&retry_error),
        -32031,
        "unknown durable identity is never replayed"
    );
    assert!(!blocked_path.exists());

    let other_path = workspace.join("capacity-must-not-be-created");
    let over_capacity = workspace_operation_receipts_v2_review_request(
        kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
        &context,
        target_id,
        None,
        json!({
            "clientRequestId": "v2-over-capacity-id",
            "scopeId": scope_id,
            "workspacePath": other_path.to_string_lossy(),
            "action": "create",
        }),
    );
    let capacity_error = super::workspace_operation_receipts_v2::dispatch_with_receipt_limit(
        &authority,
        &engine,
        &over_capacity,
        1,
    )
    .await
    .unwrap_err();
    assert_eq!(
        super::workspace_operation_receipts_v2::error_code(&capacity_error),
        -32032
    );
    assert!(!other_path.exists());
    let quota: Value =
        serde_json::from_slice(&std::fs::read(ledger.join("quota")).unwrap()).unwrap();
    assert_eq!(quota["reserved"], 1);
    assert_eq!(
        std::fs::read_dir(&ledger)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json"))
            .count(),
        1,
        "capacity rejection publishes no second receipt record"
    );

    let reopened_engine = retention_context_review_engine(&workspace);
    let reopened_authority = workspace_operation_receipts_v2_review_authority(
        &reopened_engine,
        &account_root,
        kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
    );
    let reopened_unknown = super::workspace_operation_receipts_v2::dispatch(
        &reopened_authority,
        &reopened_engine,
        &read_unknown,
    )
    .await
    .unwrap();
    assert_eq!(
        reopened_unknown["receipt"]["status"], "unknown",
        "restart preserves the conservative unknown reservation"
    );
}

#[tokio::test]
#[cfg(target_os = "linux")]
async fn workspace_operation_receipts_v2_review_bounded_file_budget_rejects_at_and_above_limit() {
    let quota_limit = 1usize;
    let file_limit = quota_limit * 2 + 8;

    for quota_present in [false, true] {
        for extra_file in [0usize, 1] {
            let fixture = retention_context_review_tempdir();
            let workspace = fixture.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();
            let account_root = retention_context_review_account_root(&fixture);
            let engine = retention_context_review_engine(&workspace);
            let context = retention_context_review_local_context();
            let target_id = "stored-server-target";
            let authority = workspace_operation_receipts_v2_review_authority(
                &engine,
                &account_root,
                kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
            );
            let scope = workspace_operation_receipts_v2_review_scope(
                &authority, &engine, &context, target_id, None,
            )
            .await;
            let ledger = account_root.join("workspace-operations-v2");
            kcoder_config::PrivateDirectory::open_or_create(&ledger).unwrap();

            let fixed_files = 1 + if quota_present { 1 } else { 0 }; // lock + optional quota
            let orphan_count = file_limit - fixed_files + extra_file;
            for index in 0..orphan_count {
                std::fs::write(
                    ledger.join(format!("orphan-atomic-temp-{index:02}.bin")),
                    b"retained after interrupted atomic update",
                )
                .unwrap();
            }
            let quota_path = ledger.join("quota");
            let original_quota = if quota_present {
                let bytes = serde_json::to_vec(&json!({"version": 2, "reserved": 0})).unwrap();
                std::fs::write(&quota_path, &bytes).unwrap();
                Some(bytes)
            } else {
                None
            };

            // dispatch creates operations.lock before the production bounded
            // count; the prefilled regular files therefore exercise exactly
            // the threshold and threshold+1 totals seen by reserve_quota.
            let target = workspace.join(format!(
                "must-not-dispatch-{}-{}",
                if quota_present { "quota" } else { "no-quota" },
                extra_file
            ));
            let request = workspace_operation_receipts_v2_review_request(
                kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
                &context,
                target_id,
                None,
                json!({
                    "clientRequestId": format!("v2-file-bound-{quota_present}-{extra_file}"),
                    "scopeId": scope["scopeId"],
                    "workspacePath": target.to_string_lossy(),
                    "action": "create",
                }),
            );
            let error = super::workspace_operation_receipts_v2::dispatch_with_receipt_limit(
                &authority,
                &engine,
                &request,
                quota_limit,
            )
            .await
            .unwrap_err();
            assert_eq!(
                super::workspace_operation_receipts_v2::error_code(&error),
                -32032,
                "bounded count at/above {file_limit} must reject before dispatch; quota_present={quota_present}, extra_file={extra_file}"
            );
            assert!(
                !target.exists(),
                "capacity rejection must not dispatch mkdir"
            );
            assert_eq!(
                std::fs::read_dir(&ledger)
                    .unwrap()
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| {
                        entry
                            .path()
                            .extension()
                            .is_some_and(|extension| extension == "json")
                    })
                    .count(),
                0,
                "capacity rejection must not publish a receipt record"
            );
            assert_eq!(
                std::fs::read(&quota_path).ok(),
                original_quota,
                "capacity rejection must preserve existing quota bytes or absence"
            );
        }
    }
}
