fn initialize_thread_presence(server: &mut TestAppServer, request_id: i64, offer: bool) -> Value {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-27",
            "clientInfo": {"name": "thread-presence-test", "version": "1"},
            "capabilities": {"experimental": {"threadPresenceReadV1": offer}}
        }
    }));
    server.response(request_id)
}

fn initialize_presence_and_creation_receipts(
    server: &mut RetentionAuthorityServer,
    request_id: i64,
) -> Value {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2026-07-27",
            "clientInfo": {"name": "thread-presence-delete-test", "version": "1"},
            "capabilities": {"experimental": {
                "threadPresenceReadV1": true,
                "threadCreationReceiptsV1": true
            }}
        }
    }));
    server.response(request_id)
}

#[test]
fn thread_presence_requires_negotiation_and_keeps_cold_history_unknown() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut unnegotiated = TestAppServer::builder(&workspace, &settings)
        .env("HOME", temp.path())
        .without_scenario()
        .spawn();
    let initialized = initialize_thread_presence(&mut unnegotiated, 1, false);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadPresenceReadV1"],
        false
    );
    unnegotiated.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/presence/read",
        "params": {"threadId": "thread-presence-fixture"}
    }));
    let refused = unnegotiated.response(2);
    assert_eq!(refused["error"]["code"], -32602, "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("threadPresenceReadV1 negotiation is required"),
        "{refused}"
    );
    unnegotiated.shutdown_successfully();

    let mut server = TestAppServer::builder(&workspace, &settings)
        .env("HOME", temp.path())
        .scenario("full-turn")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("0")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    let initialized = initialize_thread_presence(&mut server, 3, true);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadPresenceReadV1"], true,
        "the offered Linux capability must be echoed"
    );
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}));
    let started = server.response(4);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .expect("thread/start returns a thread id")
        .to_owned();
    server.send(json!({
        "jsonrpc":"2.0","id":5,"method":"turn/start",
        "params":{"threadId":thread_id.clone(),"input":[{"type":"text","text":"persist a fixture turn"}]}
    }));
    let turn = server.response(5);
    assert!(turn.get("error").is_none(), "{turn}");
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );

    server.send(json!({
        "jsonrpc":"2.0","id":6,"method":"thread/presence/read",
        "params":{"threadId":thread_id.clone()}
    }));
    let resident = server.response(6);
    assert_eq!(resident["result"]["status"], "present", "{resident}");
    assert_eq!(
        resident["result"]["reason"], "residentRuntime",
        "{resident}"
    );
    server.shutdown_successfully();

    let mut cold_server = TestAppServer::builder(&workspace, &settings)
        .env("HOME", temp.path())
        .without_scenario()
        .spawn();
    let initialized = initialize_thread_presence(&mut cold_server, 7, true);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadPresenceReadV1"],
        true
    );
    cold_server.send(json!({
        "jsonrpc":"2.0","id":8,"method":"thread/presence/read",
        "params":{"threadId":thread_id.clone()}
    }));
    let cold = cold_server.response(8);
    assert_eq!(cold["result"]["status"], "unknown", "{cold}");
    assert_eq!(
        cold["result"]["reason"], "coldSourceNotAuthorized",
        "a cold physical history source is not workspace authority: {cold}"
    );
    assert!(!cold.to_string().contains("history.jsonl"), "{cold}");
    cold_server.shutdown_successfully();
}

fn create_thread_deleted_through_real_retention_cleanup(
    fixture: &RetentionAuthorityFixture,
) -> String {
    let context = retention_authority_local_context();
    let mut deleting =
        RetentionAuthorityServer::spawn(fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut deleting, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadPresenceReadV1"], true,
        "the Linux presence capability must be negotiated"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"], true,
        "the stable creation request materializes an empty history without a turn"
    );

    deleting.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {"clientRequestId": "presence-delete-proof-create"}
    }));
    let started = deleting.response(2);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .expect("thread/start returns the created thread id")
        .to_owned();
    deleting.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "thread/creation/read",
        "params": {"clientRequestId": "presence-delete-proof-create"}
    }));
    let creation = deleting.response(3);
    assert!(creation.get("error").is_none(), "{creation}");
    assert_eq!(
        creation["result"]["receipt"]["status"], "ready",
        "{creation}"
    );
    assert_eq!(
        creation["result"]["receipt"]["threadId"], thread_id,
        "{creation}"
    );
    let history_path = find_named_file(&fixture.config, &format!("{thread_id}.jsonl"))
        .expect("thread/start with a creation identity materializes its empty history");
    assert!(history_path.is_file(), "{}", history_path.display());

    // This performs the real local upload/save and reserve RPCs. The ready
    // receipt makes thread/delete take its durable deletion-proof path.
    let ready_receipt = retained_turn_batch_create_receipt(
        &mut deleting,
        &initialized,
        &context,
        "presence-test-target",
        &thread_id,
        1,
        10,
        11,
        "presence-proof.txt",
        b"local retained deletion witness",
    );
    assert!(!ready_receipt.retention_id.is_empty());

    deleting.send(json!({
        "jsonrpc": "2.0",
        "id": 20,
        "method": "thread/delete",
        "params": {"threadId": thread_id.clone()}
    }));
    let deleted = deleting.response(20);
    assert!(deleted.get("error").is_none(), "{deleted}");
    assert_eq!(deleted["result"]["deleted"], true, "{deleted}");
    assert!(
        !history_path.exists(),
        "thread/delete removes the materialized primary history"
    );
    deleting.shutdown_successfully();
    thread_id
}

#[test]
fn thread_presence_reports_absent_after_real_retained_thread_delete() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let thread_id = create_thread_deleted_through_real_retention_cleanup(&fixture);
    let mut cold = RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut cold, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    cold.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/presence/read",
        "params": {"threadId": thread_id.clone()}
    }));
    let absent = cold.response(2);
    assert_eq!(absent["result"]["status"], "absent", "{absent}");
    assert_eq!(
        absent["result"]["reason"], "boundDeletedPrimarySource",
        "only the real, workspace-bound delete proof authorizes this absence: {absent}"
    );
    cold.shutdown_successfully();
}

#[test]
fn thread_presence_is_unknown_when_real_deleted_thread_has_compatibility_root() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let thread_id = create_thread_deleted_through_real_retention_cleanup(&fixture);

    // Linux retains the old underscore-derived project root as a compatibility
    // candidate. A secure existing root makes the observation inconclusive.
    use std::os::unix::fs::PermissionsExt;
    let canonical_workspace = std::fs::canonicalize(&fixture.workspace).unwrap();
    let legacy_key = canonical_workspace
        .to_string_lossy()
        .replace(['/', '\\', ':', ' '], "_");
    let legacy_root = fixture.config.join("projects").join(legacy_key);
    std::fs::create_dir_all(&legacy_root).unwrap();
    std::fs::set_permissions(&legacy_root, std::fs::Permissions::from_mode(0o700)).unwrap();

    let mut compatibility =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut compatibility, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    compatibility.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/presence/read",
        "params": {"threadId": thread_id}
    }));
    let unknown = compatibility.response(2);
    assert_eq!(unknown["result"]["status"], "unknown", "{unknown}");
    assert_eq!(
        unknown["result"]["reason"], "compatibilityRootPresent",
        "an existing compatibility root prevents an absence claim: {unknown}"
    );
    compatibility.shutdown_successfully();
}

fn create_materialized_thread_without_retention_receipt(
    fixture: &RetentionAuthorityFixture,
    client_request_id: &str,
) -> (String, std::path::PathBuf) {
    let mut server = RetentionAuthorityServer::spawn(fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut server, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadPresenceReadV1"], true,
        "the Linux presence capability must be negotiated"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["threadCreationReceiptsV1"], true,
        "the stable creation request materializes an empty history without a turn"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {"clientRequestId": client_request_id}
    }));
    let started = server.response(2);
    assert!(started.get("error").is_none(), "{started}");
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .expect("thread/start returns the created thread id")
        .to_owned();

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "thread/creation/read",
        "params": {"clientRequestId": client_request_id}
    }));
    let creation = server.response(3);
    assert!(creation.get("error").is_none(), "{creation}");
    assert_eq!(
        creation["result"]["receipt"]["status"], "ready",
        "{creation}"
    );
    assert_eq!(
        creation["result"]["receipt"]["threadId"], thread_id,
        "{creation}"
    );

    let history_path = find_named_file(&fixture.config, &format!("{thread_id}.jsonl"))
        .expect("thread/start with a creation identity materializes its empty history");
    assert!(history_path.is_file(), "{}", history_path.display());
    server.shutdown_successfully();
    (thread_id, history_path)
}

fn delete_ordinary_thread_without_retention_receipt(
    fixture: &RetentionAuthorityFixture,
    thread_id: &str,
) -> Value {
    let mut server = RetentionAuthorityServer::spawn(fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut server, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/delete",
        "params": {"threadId": thread_id}
    }));
    let deleted = server.response(2);
    server.shutdown_successfully();
    deleted
}

fn read_cold_thread_presence(fixture: &RetentionAuthorityFixture, thread_id: &str) -> Value {
    let mut server = RetentionAuthorityServer::spawn(fixture, &retention_authority_local_os_args());
    let initialized = initialize_presence_and_creation_receipts(&mut server, 1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/presence/read",
        "params": {"threadId": thread_id}
    }));
    let presence = server.response(2);
    server.shutdown_successfully();
    presence
}

#[test]
fn thread_presence_reports_absent_after_real_ordinary_thread_delete() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let (thread_id, history_path) =
        create_materialized_thread_without_retention_receipt(&fixture, "ordinary-delete-absent");

    let deleted = delete_ordinary_thread_without_retention_receipt(&fixture, &thread_id);
    assert!(deleted.get("error").is_none(), "{deleted}");
    assert_eq!(deleted["result"]["deleted"], true, "{deleted}");
    assert!(
        deleted["result"]["deletedFiles"].as_u64().unwrap_or(0) >= 1,
        "the original primary history counts as deleted: {deleted}"
    );
    assert!(
        !history_path.exists(),
        "thread/delete removes primary history"
    );

    let retried = delete_ordinary_thread_without_retention_receipt(&fixture, &thread_id);
    assert!(retried.get("error").is_none(), "{retried}");
    assert_eq!(retried["result"]["deleted"], true, "{retried}");
    assert_eq!(
        retried["result"]["deletedFiles"], 0,
        "a proof retry with no primary must not count the missing history: {retried}"
    );

    let absent = read_cold_thread_presence(&fixture, &thread_id);
    assert_eq!(absent["result"]["status"], "absent", "{absent}");
    assert_eq!(
        absent["result"]["reason"], "boundDeletedPrimarySource",
        "ordinary deletion must persist the same workspace-bound source proof: {absent}"
    );
}

#[test]
fn ordinary_delete_presence_stays_unknown_with_compatibility_root() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let (thread_id, _) =
        create_materialized_thread_without_retention_receipt(&fixture, "ordinary-delete-compat");
    let deleted = delete_ordinary_thread_without_retention_receipt(&fixture, &thread_id);
    assert!(deleted.get("error").is_none(), "{deleted}");

    use std::os::unix::fs::PermissionsExt;
    let canonical_workspace = std::fs::canonicalize(&fixture.workspace).unwrap();
    let legacy_key = canonical_workspace
        .to_string_lossy()
        .replace(['/', '\\', ':', ' '], "_");
    let legacy_root = fixture.config.join("projects").join(legacy_key);
    std::fs::create_dir_all(&legacy_root).unwrap();
    std::fs::set_permissions(&legacy_root, std::fs::Permissions::from_mode(0o700)).unwrap();

    let unknown = read_cold_thread_presence(&fixture, &thread_id);
    assert_eq!(unknown["result"]["status"], "unknown", "{unknown}");
    assert_eq!(
        unknown["result"]["reason"], "compatibilityRootPresent",
        "an existing compatibility root prevents an absence claim: {unknown}"
    );
}

#[test]
fn thread_presence_keeps_legacy_unbound_ordinary_deletion_unknown() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let (thread_id, history_path) =
        create_materialized_thread_without_retention_receipt(&fixture, "legacy-unbound-delete");

    // Model a persisted deletion from a pre-bound-proof writer through State's
    // existing unbound delete API; do not synthesize a control record by hand.
    kcoder_state::delete_session_history_files(&history_path).unwrap();
    assert!(
        !history_path.exists(),
        "legacy delete API removed the source"
    );

    let unknown = read_cold_thread_presence(&fixture, &thread_id);
    assert_eq!(unknown["result"]["status"], "unknown", "{unknown}");
    assert_eq!(
        unknown["result"]["reason"], "legacyDeletionWithoutBinding",
        "an unbound legacy deletion cannot be upgraded to workspace absence: {unknown}"
    );
}
