// Real JSONL/private-parent producer contracts; no Gateway, Provider or Mobile.
#[cfg(target_os = "linux")]
fn retained_upload_stdio_request(
    id: i64,
    method: &str,
    context: &Value,
    mut params: Value,
) -> Value {
    params["trustedContext"] = context.clone();
    workspace_receipts_v2_stdio_request(id, method, context, params, "target-a", None)
}
#[cfg(target_os = "linux")]
fn retained_upload_stdio_params(initialized: &Value) -> Value {
    let admission = &initialized["result"]["attachmentUploadAdmission"];
    assert_eq!(admission["version"], 1, "{initialized}");
    let namespace = admission["rootNamespace"].as_str().unwrap();
    let epoch = admission["admissionEpoch"].as_u64().unwrap();
    json!({"ownerRequest": {"clientOwnerRequestId": format!("o1.{namespace}.{epoch}.0123456789abcdef0123456789abcdef"),
        "immutableParameters": {"purpose": "attachment-upload"}},
        "clientUploadId": format!("u1.{namespace}.{epoch}.0123456789abcdef0123456789abcdef")})
}
#[test]
#[cfg(target_os = "linux")]
fn retained_upload_stdio_typed_save_read_restart_exact_stage() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let context = retention_authority_local_context();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = server.initialize();
    assert_ne!(
        initialized["result"]["capabilities"]["stagedAttachmentRetentionReceiptsV1"],
        true
    );
    let query = retained_upload_stdio_params(&initialized);
    server.send(retained_upload_stdio_request(
        2,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    assert_eq!(server.response(2)["result"]["lookup"]["outcome"], "absent");
    let mut save = query.clone();
    save["filename"] = json!("input.txt");
    save["size"] = json!(11);
    save["contentSha256"] = json!(format!("{:x}", Sha256::digest(b"hello world")));
    save["contentBase64"] = json!("aGVsbG8gd29ybGQ=");
    server.send(retained_upload_stdio_request(
        3,
        "attachment/retention/upload/save",
        &context,
        save.clone(),
    ));
    let saved = server.response(3);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["lookup"]["recovery"]["state"], "sealed");
    assert_eq!(saved["result"]["lookup"]["recovery"]["confirmedBytes"], 11);
    let stage = saved["result"]["lookup"]["recovery"]["stageRef"].clone();
    assert!(stage.is_object());
    server.shutdown_successfully();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let second = server.initialize();
    assert_eq!(
        second["result"]["attachmentUploadAdmission"]["rootNamespace"],
        initialized["result"]["attachmentUploadAdmission"]["rootNamespace"]
    );
    // Treat first successful save response as lost: same public IDs, same bytes,
    // no new owner/start ID. Replaying save must return the same durable stage.
    server.send(retained_upload_stdio_request(
        4,
        "attachment/retention/upload/save",
        &context,
        save,
    ));
    assert_eq!(
        server.response(4)["result"]["lookup"]["recovery"]["stageRef"],
        stage
    );
    server.send(retained_upload_stdio_request(
        5,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    assert_eq!(
        server.response(5)["result"]["lookup"]["recovery"]["stageRef"],
        stage
    );
    let mut foreign = context.clone();
    foreign["deviceId"] = json!("foreign-device");
    server.send(retained_upload_stdio_request(
        6,
        "attachment/retention/upload/read",
        &foreign,
        query,
    ));
    let refused = server.response(6);
    assert!(refused.get("error").is_some());
    assert!(refused.get("result").is_none());
    server.shutdown_successfully();
}
#[test]
#[cfg(target_os = "linux")]
fn retained_upload_stdio_no_initialize_public_notification_and_duplicate_are_not_admitted() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let context = retention_authority_local_context();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    server.send(retained_upload_stdio_request(
        10,
        "attachment/retention/upload/read",
        &context,
        json!({}),
    ));
    retention_authority_assert_error(&server.response(10), -32002);
    let initialized = server.initialize();
    let query = retained_upload_stdio_params(&initialized);
    server.send(json!({"jsonrpc":"2.0", "id":11, "method":"attachment/retention/upload/read", "params":query}));
    retention_authority_assert_error(&server.response(11), -32602);
    let mut start = query.clone();
    start["filename"] = json!("input.txt");
    start["size"] = json!(11);
    start["contentSha256"] = json!(format!("{:x}", Sha256::digest(b"hello world")));
    let mut notification = retained_upload_stdio_request(
        12,
        "attachment/retention/upload/start",
        &context,
        start.clone(),
    );
    notification.as_object_mut().unwrap().remove("id");
    server.send(notification);
    // Barrier request proves the notification did not admit an owner/upload.
    server.send(retained_upload_stdio_request(
        13,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    assert_eq!(server.response(13)["result"]["lookup"]["outcome"], "absent");
    let mut duplicate = serde_json::to_string(&retained_upload_stdio_request(
        14,
        "attachment/retention/upload/start",
        &context,
        start,
    ))
    .unwrap();
    let marker = "\"clientUploadId\":";
    let position = duplicate.find(marker).unwrap();
    duplicate.insert_str(position, "\"clientUploadId\":\"forged\",");
    duplicate.push('\n');
    server.write_raw(duplicate.as_bytes());
    retention_authority_assert_error(&server.response(14), -32602);
    server.send(retained_upload_stdio_request(
        15,
        "attachment/retention/upload/read",
        &context,
        query,
    ));
    assert_eq!(server.response(15)["result"]["lookup"]["outcome"], "absent");
    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retained_upload_stdio_chunks_lost_ack_restart_finish_cancel_same_ids() {
    let temp = workspace_receipts_v2_stdio_tempdir();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let context = retention_authority_local_context();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = server.initialize();
    let query = retained_upload_stdio_params(&initialized);
    let mut start = query.clone();
    start["filename"] = json!("input.txt");
    start["size"] = json!(11);
    start["contentSha256"] = json!(format!("{:x}", Sha256::digest(b"hello world")));
    server.send(retained_upload_stdio_request(
        30,
        "attachment/retention/upload/start",
        &context,
        start.clone(),
    ));
    let started = server.response(30);
    assert!(started.get("error").is_none(), "{started}");
    assert_eq!(started["result"]["lookup"]["recovery"]["confirmedBytes"], 0);
    let mut first = query.clone();
    first["offset"] = json!(0);
    first["length"] = json!(6);
    first["chunkSha256"] = json!(format!("{:x}", Sha256::digest(b"hello ")));
    first["contentBase64"] = json!("aGVsbG8g");
    server.send(retained_upload_stdio_request(
        31,
        "attachment/retention/upload/chunk",
        &context,
        first.clone(),
    ));
    // response(32) deliberately discards response 31: exact readback, rather
    // than a consumed chunk ACK, confirms the durable offset before restart.
    server.send(retained_upload_stdio_request(
        32,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    let read = server.response(32);
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(read["result"]["lookup"]["recovery"]["confirmedBytes"], 6);
    server.shutdown_successfully();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    server.initialize();
    server.send(retained_upload_stdio_request(
        33,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    assert_eq!(
        server.response(33)["result"]["lookup"]["recovery"]["confirmedBytes"],
        6
    );
    server.send(retained_upload_stdio_request(
        34,
        "attachment/retention/upload/chunk",
        &context,
        first,
    ));
    assert_eq!(
        server.response(34)["result"]["lookup"]["recovery"]["confirmedBytes"],
        6,
        "exact replay must not append twice"
    );
    let mut second = query.clone();
    second["offset"] = json!(6);
    second["length"] = json!(5);
    second["chunkSha256"] = json!(format!("{:x}", Sha256::digest(b"world")));
    second["contentBase64"] = json!("d29ybGQ=");
    server.send(retained_upload_stdio_request(
        35,
        "attachment/retention/upload/chunk",
        &context,
        second,
    ));
    assert_eq!(
        server.response(35)["result"]["lookup"]["recovery"]["confirmedBytes"],
        11
    );
    server.send(retained_upload_stdio_request(
        36,
        "attachment/retention/upload/finish",
        &context,
        query.clone(),
    ));
    server.send(retained_upload_stdio_request(
        37,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    let sealed = server.response(37);
    assert!(sealed.get("error").is_none(), "{sealed}");
    assert_eq!(sealed["result"]["lookup"]["recovery"]["state"], "sealed");
    let stage = sealed["result"]["lookup"]["recovery"]["stageRef"].clone();
    assert!(stage.is_object());
    server.shutdown_successfully();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    server.initialize();
    server.send(retained_upload_stdio_request(
        38,
        "attachment/retention/upload/finish",
        &context,
        query.clone(),
    ));
    assert_eq!(
        server.response(38)["result"]["lookup"]["recovery"]["stageRef"],
        stage
    );
    server.send(retained_upload_stdio_request(
        39,
        "attachment/retention/upload/cancel",
        &context,
        query.clone(),
    ));
    server.send(retained_upload_stdio_request(
        40,
        "attachment/retention/upload/read",
        &context,
        query.clone(),
    ));
    assert_eq!(
        server.response(40)["result"]["lookup"]["recovery"]["state"],
        "cancelled"
    );
    server.shutdown_successfully();
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    server.initialize();
    server.send(retained_upload_stdio_request(
        41,
        "attachment/retention/upload/start",
        &context,
        start,
    ));
    assert_eq!(
        server.response(41)["result"]["lookup"]["recovery"]["state"],
        "cancelled",
        "cancelled ID must not admit again"
    );
    server.send(retained_upload_stdio_request(
        42,
        "attachment/retention/upload/read",
        &context,
        query,
    ));
    let cancelled = server.response(42);
    assert!(cancelled.get("error").is_none(), "{cancelled}");
    assert_eq!(
        cancelled["result"]["lookup"]["recovery"]["state"],
        "cancelled"
    );
    assert!(cancelled["result"]["lookup"]["recovery"]["stageRef"].is_null());
    server.shutdown_successfully();
}
