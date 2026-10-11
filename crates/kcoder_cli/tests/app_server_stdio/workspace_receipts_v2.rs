#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_request(
    id: i64,
    method: &str,
    context: &Value,
    params: Value,
    target_id: &str,
    account: Option<(&str, &str)>,
) -> Value {
    let mut request = retention_authority_request(id, method, context, params);
    request["kcoderPrivateRetention"]["workspaceTargetId"] = json!(target_id);
    if let Some((role, authorization_generation)) = account {
        request["kcoderPrivateRetention"]["workspaceAccount"] = json!({
            "role": role,
            "authorizationGeneration": authorization_generation,
        });
    }
    request
}

#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_tempdir() -> tempfile::TempDir {
    let private_parent = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/private-phone-latency-implementation")
        .canonicalize()
        .expect("private workspace receipt fixture parent must already exist");
    tempfile::Builder::new()
        .prefix("workspace-receipts-v2-stdio-")
        .tempdir_in(private_parent)
        .expect("create private stdio fixture")
}

#[cfg(target_os = "linux")]
impl RetentionAuthorityServer {
    fn response_after_request(&mut self, request: Value, id: i64) -> Value {
        self.send(request);
        self.response(id)
    }
}

#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_scope(
    server: &mut RetentionAuthorityServer,
    id: i64,
    context: &Value,
    target_id: &str,
    account: Option<(&str, &str)>,
) -> Value {
    server.response_after_request(
        workspace_receipts_v2_stdio_request(
            id,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
            context,
            json!({}),
            target_id,
            account,
        ),
        id,
    )
}

#[test]
#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_requires_initialization_and_unique_private_authority() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let ledger = fixture.config.join("workspace-operations-v2");
    let context = retention_authority_local_context();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());

    // The existing connection initialization gate runs before private-frame
    // decoding and before the V2 ledger can be created.
    server.send(workspace_receipts_v2_stdio_request(
        31,
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
        &context,
        json!({}),
        "stored-server-target",
        None,
    ));
    retention_authority_assert_error(&server.response(31), -32002);
    assert!(!ledger.exists());

    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");

    // A public request cannot opt into V2 by naming only a V2 method.
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 32,
        "method": kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
        "params": {},
    }));
    retention_authority_assert_error(&server.response(32), -32602);
    assert!(!ledger.exists());

    // Exercise the actual raw-frame duplicate-key decoder. This private key
    // appears only in the OS-trusted extension and cannot be repeated after
    // ordinary JSON Value parsing has erased duplicate information.
    let mut duplicate_target = serde_json::to_string(&workspace_receipts_v2_stdio_request(
        33,
        kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
        &context,
        json!({}),
        "stored-server-target",
        None,
    ))
    .unwrap();
    let marker = "\"workspaceTargetId\":\"stored-server-target\"";
    let insertion = duplicate_target
        .find(marker)
        .expect("serialized request has its private target key")
        + marker.len();
    duplicate_target.insert_str(insertion, ",\"workspaceTargetId\":\"forged-second-target\"");
    duplicate_target.push('\n');
    server.write_raw(duplicate_target.as_bytes());
    retention_authority_assert_error(&server.response(33), -32602);
    assert!(!ledger.exists());

    let scope = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            34,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
            &context,
            json!({}),
            "stored-server-target",
            None,
        ),
        34,
    );
    assert!(scope.get("error").is_none(), "{scope}");
    assert_eq!(scope["result"]["version"], 2);
    assert!(scope["result"]["rootId"].as_str().is_some());
    assert!(scope["result"]["scopeId"].as_str().is_some());
    assert!(
        !ledger.exists(),
        "scope discovery creates no receipt ledger"
    );

    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_account_parent_creates_and_replays_exact_scoped_result() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let ledger = fixture.config.join("workspace-operations-v2");
    let context = retention_authority_account_context("review-account");
    let target_id = "stored-server-target";
    let account = Some(("owner", "17"));
    let mut server = RetentionAuthorityServer::spawn(
        &fixture,
        &retention_authority_account_args("review-account", retention_authority_uid()),
    );
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");

    let scope_response = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            41,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
            &context,
            json!({}),
            target_id,
            account,
        ),
        41,
    );
    assert!(scope_response.get("error").is_none(), "{scope_response}");
    let scope_id = scope_response["result"]["scopeId"]
        .as_str()
        .expect("scopeV2 returns the trusted scope ID")
        .to_string();
    assert_eq!(scope_response["result"]["version"], 2);

    let missing = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            42,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
            &context,
            json!({
                "clientRequestId": "v2-stdio-not-created",
                "scopeId": scope_id,
            }),
            target_id,
            account,
        ),
        42,
    );
    assert!(missing.get("error").is_none(), "{missing}");
    assert!(
        missing["result"]["receipt"].is_null(),
        "only an exact current scope can report a missing ID as null"
    );
    assert!(!ledger.exists());

    let workspace_path = fixture.workspace.join("created-by-v2");
    let mutation_params = json!({
        "clientRequestId": "v2-stdio-exact-replay",
        "scopeId": scope_id,
        "workspacePath": workspace_path.to_string_lossy(),
        "action": "create",
        "label": "Verified account workspace",
    });
    let created = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            43,
            kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
            &context,
            mutation_params.clone(),
            target_id,
            account,
        ),
        43,
    );
    assert!(created.get("error").is_none(), "{created}");
    assert!(workspace_path.is_dir());
    assert_eq!(created["result"]["receipt"]["status"], "ready");
    assert_eq!(
        created["result"]["result"]["mapping"]["deviceId"], target_id,
        "the registry receives the trusted selected target ID"
    );
    assert_ne!(
        created["result"]["result"]["mapping"]["deviceId"], context["deviceId"],
        "the Mobile device authority is not used as the registry target"
    );

    let replay = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            44,
            kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
            &context,
            mutation_params,
            target_id,
            account,
        ),
        44,
    );
    assert!(replay.get("error").is_none(), "{replay}");
    assert_eq!(
        replay["result"], created["result"],
        "the exact same client ID returns the original immutable result"
    );

    let read = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            45,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
            &context,
            json!({
                "clientRequestId": "v2-stdio-exact-replay",
                "scopeId": scope_id,
            }),
            target_id,
            account,
        ),
        45,
    );
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["receipt"]["status"], "ready");
    assert_eq!(
        read["result"]["receipt"]["workspacePath"],
        workspace_path.to_string_lossy().as_ref()
    );

    let before_conflict = retention_authority_snapshot(&ledger).unwrap();
    let wrong_scope = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            46,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
            &context,
            json!({
                "clientRequestId": "v2-stdio-exact-replay",
                "scopeId": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            }),
            target_id,
            account,
        ),
        46,
    );
    retention_authority_assert_error(&wrong_scope, -32001);
    assert!(
        !wrong_scope["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(workspace_path.to_str().unwrap()),
        "scope rejection must not disclose the prior ready path"
    );
    assert_eq!(
        retention_authority_snapshot(&ledger).unwrap(),
        before_conflict,
        "a rejected expected scope leaves the account ledger unchanged"
    );

    // A valid scope request under a changed verified role has a different
    // scope; it cannot read the prior scope's known ID or learn its path.
    let changed_role_scope = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            47,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
            &context,
            json!({}),
            target_id,
            Some(("member", "17")),
        ),
        47,
    );
    assert!(
        changed_role_scope.get("error").is_none(),
        "{changed_role_scope}"
    );
    assert_ne!(
        changed_role_scope["result"]["scopeId"],
        scope_response["result"]["scopeId"]
    );
    let changed_role_read = server.response_after_request(
        workspace_receipts_v2_stdio_request(
            48,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
            &context,
            json!({
                "clientRequestId": "v2-stdio-exact-replay",
                "scopeId": changed_role_scope["result"]["scopeId"],
            }),
            target_id,
            Some(("member", "17")),
        ),
        48,
    );
    retention_authority_assert_error(&changed_role_read, -32001);
    assert_eq!(
        retention_authority_snapshot(&ledger).unwrap(),
        before_conflict,
        "cross-role lookup cannot mutate the original receipt"
    );

    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_scope_from_another_workspace_root_cannot_read_ready_path() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let first_fixture = retention_authority_fixture(&temp, "workspace-a");
    let second_workspace = temp.path().join("workspace-b");
    std::fs::create_dir_all(&second_workspace).unwrap();
    let second_fixture = RetentionAuthorityFixture {
        workspace: second_workspace,
        config: first_fixture.config.clone(),
        settings: first_fixture.settings.clone(),
    };
    let context = retention_authority_local_context();
    let target_id = "stored-server-target";
    let mut first_server =
        RetentionAuthorityServer::spawn(&first_fixture, &retention_authority_local_os_args());
    let initialized = first_server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");

    let first_scope = first_server.response_after_request(
        workspace_receipts_v2_stdio_request(
            51,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_SCOPE_V2,
            &context,
            json!({}),
            target_id,
            None,
        ),
        51,
    );
    assert!(first_scope.get("error").is_none(), "{first_scope}");
    let scope_id = first_scope["result"]["scopeId"]
        .as_str()
        .unwrap()
        .to_string();
    let ready_path = first_fixture.workspace.join("ready-only-under-root-a");
    let created = first_server.response_after_request(
        workspace_receipts_v2_stdio_request(
            52,
            kcoder_app_protocol::METHOD_WORKSPACE_PREPARE_V2,
            &context,
            json!({
                "clientRequestId": "v2-cross-root-known-id",
                "scopeId": scope_id,
                "workspacePath": ready_path.to_string_lossy(),
                "action": "create",
            }),
            target_id,
            None,
        ),
        52,
    );
    assert!(created.get("error").is_none(), "{created}");
    assert!(ready_path.is_dir());
    let ledger = first_fixture.config.join("workspace-operations-v2");
    let before = retention_authority_snapshot(&ledger).unwrap();
    first_server.shutdown_successfully();

    let mut second_server =
        RetentionAuthorityServer::spawn(&second_fixture, &retention_authority_local_os_args());
    let initialized = second_server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    let second_scope = workspace_receipts_v2_stdio_scope(
        &mut second_server,
        54,
        &context,
        target_id,
        None,
    );
    assert!(second_scope.get("error").is_none(), "{second_scope}");
    assert_ne!(
        second_scope["result"]["rootId"], first_scope["result"]["rootId"],
        "the active default workspace root is part of root identity"
    );
    assert_eq!(
        second_scope["result"]["familyId"], first_scope["result"]["familyId"],
        "changing only the default workspace root keeps the trusted target family"
    );
    let cross_root = second_server.response_after_request(
        workspace_receipts_v2_stdio_request(
            53,
            kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ_V2,
            &context,
            json!({
                "clientRequestId": "v2-cross-root-known-id",
                "scopeId": scope_id,
            }),
            target_id,
            None,
        ),
        53,
    );
    retention_authority_assert_error(&cross_root, -32001);
    assert!(
        !cross_root["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(ready_path.to_str().unwrap()),
        "a different engine root cannot learn a ready path"
    );
    assert_eq!(
        retention_authority_snapshot(&ledger).unwrap(),
        before,
        "the rejected cross-root lookup does not inspect or mutate the original ledger"
    );
    second_server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn workspace_receipts_v2_stdio_family_tracks_gateway_namespace_and_stored_target() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let context = retention_authority_account_context("family-review-account");
    let target_id = "stored-family-target";
    let account = Some(("owner", "17"));
    let mut server = RetentionAuthorityServer::spawn(
        &fixture,
        &retention_authority_account_args("family-review-account", retention_authority_uid()),
    );
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");

    let base = workspace_receipts_v2_stdio_scope(&mut server, 61, &context, target_id, account);
    assert!(base.get("error").is_none(), "{base}");
    let family_id = base["result"]["familyId"]
        .as_str()
        .expect("scopeV2 returns familyId")
        .to_owned();
    assert_eq!(family_id.len(), 64);
    let scope_id = base["result"]["scopeId"].as_str().unwrap().to_owned();

    let mut alias_context = context.clone();
    alias_context["targetFingerprint"] = json!("different-alias-or-default-target");
    let alias = workspace_receipts_v2_stdio_scope(
        &mut server,
        62,
        &alias_context,
        target_id,
        account,
    );
    assert!(alias.get("error").is_none(), "{alias}");
    assert_eq!(alias["result"]["familyId"], family_id);
    assert_ne!(alias["result"]["scopeId"], scope_id);

    let mut device_context = context.clone();
    device_context["deviceId"] = json!("different-mobile-device");
    let device = workspace_receipts_v2_stdio_scope(
        &mut server,
        63,
        &device_context,
        target_id,
        account,
    );
    assert!(device.get("error").is_none(), "{device}");
    assert_eq!(device["result"]["familyId"], family_id);
    assert_ne!(device["result"]["scopeId"], scope_id);

    let account_change = workspace_receipts_v2_stdio_scope(
        &mut server,
        64,
        &context,
        target_id,
        Some(("member", "18")),
    );
    assert!(account_change.get("error").is_none(), "{account_change}");
    assert_eq!(account_change["result"]["familyId"], family_id);
    assert_ne!(account_change["result"]["scopeId"], scope_id);

    let mut namespace_context = context.clone();
    namespace_context["gatewayNamespaceId"] = json!(
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    );
    let namespace = workspace_receipts_v2_stdio_scope(
        &mut server,
        65,
        &namespace_context,
        target_id,
        account,
    );
    assert!(namespace.get("error").is_none(), "{namespace}");
    assert_ne!(namespace["result"]["familyId"], family_id);
    assert_ne!(namespace["result"]["scopeId"], scope_id);

    let other_target = workspace_receipts_v2_stdio_scope(
        &mut server,
        66,
        &context,
        "different-stored-family-target",
        account,
    );
    assert!(other_target.get("error").is_none(), "{other_target}");
    assert_ne!(other_target["result"]["familyId"], family_id);
    assert_ne!(other_target["result"]["scopeId"], scope_id);

    server.shutdown_successfully();
}
