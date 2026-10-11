// S2-A1 only establishes the trusted stdio boundary. Retention RPCs remain
// unadvertised and unconnected to RetentionService in this batch.

#[cfg(target_os = "linux")]
struct RetentionAuthorityFixture {
    workspace: std::path::PathBuf,
    config: std::path::PathBuf,
    settings: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
fn retention_authority_fixture(
    temp: &tempfile::TempDir,
    workspace_name: &str,
) -> RetentionAuthorityFixture {
    use std::os::unix::fs::PermissionsExt;

    let workspace = temp.path().join(workspace_name);
    std::fs::create_dir_all(&workspace).unwrap();
    let config = temp.path().join("account-config");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o700)).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    RetentionAuthorityFixture {
        workspace,
        config,
        settings,
    }
}

#[cfg(target_os = "linux")]
struct RetentionAuthorityServer {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    rx: std::sync::mpsc::Receiver<std::io::Result<String>>,
    stderr: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

#[cfg(target_os = "linux")]
impl RetentionAuthorityServer {
    fn spawn(fixture: &RetentionAuthorityFixture, parent_args: &[String]) -> Self {
        Self::spawn_with_parent_environment(fixture, parent_args, None)
    }

    fn spawn_with_parent_environment(
        fixture: &RetentionAuthorityFixture,
        parent_args: &[String],
        parent_environment: Option<&str>,
    ) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
        command
            .args([
                "--settings-file",
                fixture.settings.to_str().unwrap(),
                "--cwd",
                fixture.workspace.to_str().unwrap(),
                "app-server",
            ])
            .args(parent_args)
            .env("XDG_CONFIG_HOME", &fixture.config)
            .env("KCODER_CONFIG_DIR", &fixture.config)
            .env_remove("KCODER_HOME")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_TTY")
            .env_remove("KCODER_ACCOUNT_PRINCIPAL_ID")
            .env_remove("KCODER_WIKI_WORKER_MANAGED")
            .env_remove("KCODER_PRIVATE_RETENTION_PARENT_V1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(parent_environment) = parent_environment {
            command.env("KCODER_PRIVATE_RETENTION_PARENT_V1", parent_environment);
        }

        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let captured_stderr = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stderr_buffer = std::sync::Arc::clone(&captured_stderr);
        std::thread::spawn(move || {
            const STDERR_LIMIT: usize = 16 * 1024;
            let mut stderr = stderr;
            let mut chunk = [0_u8; 1024];
            loop {
                let count = match std::io::Read::read(&mut stderr, &mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                let mut captured = stderr_buffer.lock().unwrap();
                let remaining = STDERR_LIMIT.saturating_sub(captured.len());
                captured.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        });
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let _ = tx.send(line);
            }
        });
        Self {
            stdin: child.stdin.take(),
            child,
            rx,
            stderr: captured_stderr,
        }
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().expect("app-server stdin is open");
        writeln!(stdin, "{value}").unwrap();
        stdin.flush().unwrap();
    }

    fn write_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("app-server stdin is open");
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn response(&mut self, id: i64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Ok(line)) => {
                    let value: Value = serde_json::from_str(&line).unwrap();
                    if value["id"] == id {
                        return value;
                    }
                }
                Ok(Err(error)) => {
                    let status = self.child.try_wait().ok().flatten();
                    panic!(
                        "app-server stdout read failed while waiting for response {id}: {error}; child_status={status:?}; bounded_stderr={}",
                        String::from_utf8_lossy(&self.stderr.lock().unwrap())
                    );
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let status = self.child.try_wait().ok().flatten();
                    panic!(
                        "app-server stdout closed before response {id}; child_status={status:?}; bounded_stderr={}",
                        String::from_utf8_lossy(&self.stderr.lock().unwrap())
                    );
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let status = self.child.try_wait().ok().flatten();
                    panic!(
                        "app-server response {id} timed out after 30 seconds; child_status={status:?}; bounded_stderr={}",
                        String::from_utf8_lossy(&self.stderr.lock().unwrap())
                    );
                }
            }
        }
    }

    fn initialize(&mut self) -> Value {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2026-07-27",
                "clientInfo": {"name": "retention-authority-review", "version": "1"}
            }
        }));
        self.response(1)
    }

    fn shutdown_successfully(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "app-server exited unsuccessfully: {status}"
                );
                return;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                panic!("retention authority app-server did not exit after stdin closed");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for RetentionAuthorityServer {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(target_os = "linux")]
fn retention_authority_startup_output(
    fixture: &RetentionAuthorityFixture,
    parent_args: &[String],
) -> std::process::Output {
    retention_authority_startup_output_with_parent_environment(fixture, parent_args, None)
}

#[cfg(target_os = "linux")]
fn retention_authority_startup_output_with_parent_environment(
    fixture: &RetentionAuthorityFixture,
    parent_args: &[String],
    parent_environment: Option<&str>,
) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kcoder"));
    command
        .args([
            "--settings-file",
            fixture.settings.to_str().unwrap(),
            "--cwd",
            fixture.workspace.to_str().unwrap(),
            "app-server",
        ])
        .args(parent_args)
        .env("XDG_CONFIG_HOME", &fixture.config)
        .env("KCODER_CONFIG_DIR", &fixture.config)
        .env_remove("KCODER_HOME")
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_TTY")
        .env_remove("KCODER_ACCOUNT_PRINCIPAL_ID")
        .env_remove("KCODER_WIKI_WORKER_MANAGED")
        .env_remove("KCODER_PRIVATE_RETENTION_PARENT_V1");
    if let Some(parent_environment) = parent_environment {
        command.env("KCODER_PRIVATE_RETENTION_PARENT_V1", parent_environment);
    }
    command.stdin(Stdio::null()).output().unwrap()
}

#[cfg(target_os = "linux")]
fn retention_authority_encode_parent_environment(raw_json: &str) -> String {
    use base64::Engine as _;

    format!(
        "v1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_json.as_bytes())
    )
}

#[cfg(target_os = "linux")]
fn retention_authority_local_parent_environment() -> String {
    retention_authority_encode_parent_environment(r#"{"version":1,"mode":"localOs"}"#)
}

#[cfg(target_os = "linux")]
fn retention_authority_workspace_request(
    id: i64,
    method: &str,
    context: &Value,
    target_id: &str,
    params: Value,
) -> Value {
    let mut extension = retention_authority_extension(context);
    extension["workspaceTargetId"] = json!(target_id);
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
        "kcoderPrivateRetention": extension,
    })
}

#[cfg(target_os = "linux")]
fn retention_authority_shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(target_os = "linux")]
fn retention_authority_write_session_start_env_probe(
    settings: &std::path::Path,
    marker: &std::path::Path,
) {
    let mut value: Value = serde_json::from_slice(&std::fs::read(settings).unwrap()).unwrap();
    let marker = retention_authority_shell_quote(marker);
    value["hooks"] = json!({
        "SessionStart": [{"hooks": [{
            "type": "command",
            "shell": "sh",
            "timeout": 5,
            "command": format!(
                r#"if [ "${{KCODER_PRIVATE_RETENTION_PARENT_V1+x}}" = x ]; then printf present > {marker}; else printf absent > {marker}; fi"#
            ),
        }]}]
    });
    std::fs::write(settings, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[cfg(target_os = "linux")]
fn retention_authority_wait_for_file(path: &std::path::Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if std::fs::read_to_string(path).ok().as_deref() == Some(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "startup hook did not record only the reserved-key presence bit at {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn retention_authority_local_os_args() -> Vec<String> {
    vec!["--retention-parent-v1".into(), "local-os".into()]
}

#[cfg(target_os = "linux")]
fn retention_authority_account_args(principal_id: &str, uid: u32) -> Vec<String> {
    vec![
        "--retention-parent-v1".into(),
        "account".into(),
        "--retention-account-principal-id".into(),
        principal_id.into(),
        "--retention-account-uid".into(),
        uid.to_string(),
    ]
}

#[cfg(target_os = "linux")]
fn retention_authority_uid() -> u32 {
    // The account launch contract binds to the process's actual effective UID.
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "linux")]
fn retention_authority_context(principal: Value) -> Value {
    json!({
        "gatewayNamespaceId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "deviceId": "review-device-id",
        "authorizationGeneration": "review-auth-generation",
        "targetFingerprint": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "principal": principal,
    })
}

#[cfg(target_os = "linux")]
fn retention_authority_local_context() -> Value {
    retention_authority_context(json!({"kind": "localOs"}))
}

#[cfg(target_os = "linux")]
fn retention_authority_account_context(principal_id: &str) -> Value {
    retention_authority_context(json!({
        "kind": "verifiedAccount",
        "principalId": principal_id,
    }))
}

#[cfg(target_os = "linux")]
fn retention_authority_extension(context: &Value) -> Value {
    json!({"version": 1, "context": context})
}

#[cfg(target_os = "linux")]
fn retention_authority_read_params(context: &Value) -> Value {
    json!({
        "trustedContext": context,
        "selector": {
            "by": "clientRequestId",
            "clientRequestId": "review-read-probe",
        },
    })
}

#[cfg(target_os = "linux")]
fn retention_authority_request(id: i64, method: &str, context: &Value, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
        "kcoderPrivateRetention": retention_authority_extension(context),
    })
}

#[cfg(target_os = "linux")]
fn retention_authority_assert_error(response: &Value, code: i64) {
    assert_eq!(response["error"]["code"], code, "{response}");
    assert!(response.get("result").is_none(), "{response}");
}

#[cfg(target_os = "linux")]
type RetentionAuthorityTree = std::collections::BTreeMap<
    std::path::PathBuf,
    (bool, u64, u64, u64, i64, i64, Option<Vec<u8>>),
>;

#[cfg(target_os = "linux")]
fn retention_authority_snapshot(root: &std::path::Path) -> Option<RetentionAuthorityTree> {
    use std::os::unix::fs::MetadataExt;

    fn visit(root: &std::path::Path, current: &std::path::Path, tree: &mut RetentionAuthorityTree) {
        let metadata = std::fs::symlink_metadata(current).unwrap();
        let relative = current.strip_prefix(root).unwrap().to_path_buf();
        let is_dir = metadata.file_type().is_dir();
        let content = if metadata.file_type().is_file() {
            Some(std::fs::read(current).unwrap())
        } else {
            assert!(
                is_dir,
                "unexpected symlink or special file in authority root: {current:?}"
            );
            None
        };
        tree.insert(
            relative,
            (
                is_dir,
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec(),
                content,
            ),
        );
        if is_dir {
            for entry in std::fs::read_dir(current).unwrap() {
                visit(root, &entry.unwrap().path(), tree);
            }
        }
    }

    if !root.exists() {
        return None;
    }
    let mut tree = RetentionAuthorityTree::new();
    visit(root, root, &mut tree);
    Some(tree)
}

#[cfg(target_os = "linux")]
fn retention_authority_assert_no_owner_records(root: &std::path::Path) {
    for area in [
        "owners", "entries", "uploads", "intents", "receipts", "consumed", "index", "data",
        "leases",
    ] {
        let path = root.join(area);
        if path.exists() {
            assert!(
                path.is_dir(),
                "retention area must be a directory: {path:?}"
            );
            assert_eq!(
                std::fs::read_dir(&path).unwrap().count(),
                0,
                "private request created records in {path:?}"
            );
        }
    }
    assert!(
        !root.join("transaction").exists(),
        "private request must not leave a retention redo journal"
    );
}

#[cfg(target_os = "linux")]
fn retention_authority_assert_private_account_root(root: &std::path::Path, uid: u32) {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(root).unwrap();
    assert!(
        metadata.file_type().is_dir(),
        "account root is not a directory"
    );
    assert_eq!(
        metadata.uid(),
        uid,
        "account root must belong to actual euid"
    );
    assert_eq!(
        metadata.permissions().mode() & 0o777,
        0o700,
        "account root must retain private directory permissions"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_launch_flags_require_exact_account_uid_before_root_creation() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let actual_uid = retention_authority_uid();
    let wrong_uid = if actual_uid == 0 { 1 } else { actual_uid - 1 };
    let invalid_launches = [
        vec!["--retention-parent-v1".into(), "account".into()],
        vec![
            "--retention-parent-v1".into(),
            "account".into(),
            "--retention-account-principal-id".into(),
            "review-account".into(),
        ],
        vec![
            "--retention-parent-v1".into(),
            "local-os".into(),
            "--retention-account-uid".into(),
            actual_uid.to_string(),
        ],
        retention_authority_account_args("review-account", wrong_uid),
    ];

    for flags in invalid_launches {
        let output = retention_authority_startup_output(&fixture, &flags);
        assert!(
            !output.status.success(),
            "invalid launch flags must fail startup: {flags:?}; stdout={}; stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.config.join("attachment-retention-v1").exists(),
            "invalid launch flags must not initialize the account retention root"
        );
    }
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_ordinary_stdio_keeps_legacy_operations_but_cannot_self_enable_retention() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let retention_root = fixture.config.join("attachment-retention-v1");
    let mut server = TestAppServer::builder(&fixture.workspace, &fixture.settings)
        .config_dir(&fixture.config)
        .without_scenario()
        .spawn();

    let initialized = server.initialize(1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_ne!(
        initialized["result"]["capabilities"]["experimental"]["stagedAttachmentRetentionReceiptsV1"],
        true,
        "the public retention capability remains closed"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workspaceOperationReceiptsV2"],
        false,
        "ordinary argv without a trusted parent keeps Workspace V2 unavailable"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {},
    }));
    let legacy_start = server.response(2);
    assert!(legacy_start.get("error").is_none(), "{legacy_start}");

    let forged_context = retention_authority_local_context();
    server.send(retention_authority_request(
        3,
        "attachment/retention/read",
        &forged_context,
        retention_authority_read_params(&forged_context),
    ));
    retention_authority_assert_error(&server.response(3), -32001);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "attachment/retention/read",
        "params": retention_authority_read_params(&forged_context),
    }));
    retention_authority_assert_error(&server.response(4), -32001);

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "thread/list",
        "params": {},
    }));
    let list_before = server.response(5)["result"]["threads"]
        .as_array()
        .unwrap()
        .len();
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "thread/start",
        "params": {},
        "kcoderPrivateRetention": retention_authority_extension(&forged_context),
    }));
    retention_authority_assert_error(&server.response(6), -32001);
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "thread/list",
        "params": {},
    }));
    assert_eq!(
        server.response(7)["result"]["threads"]
            .as_array()
            .unwrap()
            .len(),
        list_before,
        "an unauthenticated private extension must not execute thread/start"
    );
    assert!(
        !retention_root.exists(),
        "direct stdio must not open or create the private account retention root"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 8,
        "method": "thread/start",
        "params": {},
    }));
    assert!(server.response(8).get("error").is_none());

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 20,
        "method": "attachment/upload/start",
        "params": {"filename": "legacy-upload.txt", "size": 6},
    }));
    let upload_id = server.response(20)["result"]["upload_id"]
        .as_str()
        .expect("legacy attachment upload remains available")
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 21,
        "method": "attachment/upload/chunk",
        "params": {
            "upload_id": upload_id,
            "index": 0,
            "content_base64": "bGVnYWN5",
        },
    }));
    assert_eq!(server.response(21)["result"]["accepted"], true);
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 22,
        "method": "attachment/upload/finish",
        "params": {"upload_id": upload_id},
    }));
    let legacy_upload = server.response(22);
    assert!(legacy_upload.get("error").is_none(), "{legacy_upload}");
    assert_eq!(
        std::fs::read(legacy_upload["result"]["path"].as_str().unwrap()).unwrap(),
        b"legacy",
        "ordinary attachment upload keeps its existing stdio behavior"
    );
    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_local_os_frames_validate_exact_envelope_without_writing_owner_state() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace-a");
    let retention_root = fixture.config.join("attachment-retention-v1");
    let mut server =
        RetentionAuthorityServer::spawn(&fixture, &retention_authority_local_os_args());
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_ne!(
        initialized["result"]["capabilities"]["experimental"]["stagedAttachmentRetentionReceiptsV1"],
        true,
        "parent authorization does not advertise the unfinished retention lifecycle"
    );
    assert!(
        retention_root.is_dir(),
        "the only account store is below loaded KCODER_CONFIG_DIR"
    );
    retention_authority_assert_private_account_root(&retention_root, retention_authority_uid());
    assert!(
        !fixture
            .workspace
            .join("client-sessions/attachment-retention-v1")
            .exists(),
        "the per-workspace durable Engine path cannot replace the account root"
    );
    let baseline = retention_authority_snapshot(&retention_root).unwrap();

    let context = retention_authority_local_context();
    server.send(retention_authority_request(
        2,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    ));
    let authorized_but_unwired = server.response(2);
    retention_authority_assert_error(&authorized_but_unwired, -32601);
    assert!(
        !authorized_but_unwired["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("review-device-id"),
        "errors must not echo private authority data: {authorized_but_unwired}"
    );

    let mut mismatched_params = retention_authority_read_params(&context);
    mismatched_params["trustedContext"]["deviceId"] = json!("different-device");
    server.send(retention_authority_request(
        3,
        "attachment/retention/read",
        &context,
        mismatched_params,
    ));
    retention_authority_assert_error(&server.response(3), -32602);

    let wrong_principal = retention_authority_account_context("not-the-local-os-principal");
    server.send(retention_authority_request(
        4,
        "attachment/retention/read",
        &wrong_principal,
        retention_authority_read_params(&wrong_principal),
    ));
    retention_authority_assert_error(&server.response(4), -32001);

    let mut wrong_version = retention_authority_request(
        5,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    );
    wrong_version["kcoderPrivateRetention"]["version"] = json!(2);
    server.send(wrong_version);
    retention_authority_assert_error(&server.response(5), -32602);

    let mut unknown_field = retention_authority_request(
        6,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    );
    unknown_field["kcoderPrivateRetention"]["unexpectedAuthority"] = json!("must-not-be-accepted");
    server.send(unknown_field);
    retention_authority_assert_error(&server.response(6), -32602);

    let wrong_method = retention_authority_request(7, "thread/start", &context, json!({}));
    server.send(wrong_method);
    retention_authority_assert_error(&server.response(7), -32602);

    let stage_refs = (0..33)
        .map(|index| {
            json!({
                "rootNamespace": "11111111111111111111111111111111",
                "epoch": 1,
                "ownerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "entryId": format!("{index:032x}"),
                "revision": 1,
            })
        })
        .collect::<Vec<_>>();
    server.send(retention_authority_request(
        8,
        "attachment/retention/reserve",
        &context,
        json!({
            "trustedContext": context,
            "clientRequestId": "review-reserve-probe",
            "threadId": "abcde",
            "stageRefs": stage_refs,
        }),
    ));
    retention_authority_assert_error(&server.response(8), -32602);

    let mut duplicated = serde_json::to_string(&retention_authority_request(
        9,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    ))
    .unwrap();
    let extension_start = duplicated
        .find("\"kcoderPrivateRetention\"")
        .expect("raw frame includes its private extension");
    let device_key = "\"deviceId\":\"review-device-id\"";
    let duplicate_position = extension_start
        + duplicated[extension_start..]
            .find(device_key)
            .expect("private context includes device id")
        + device_key.len();
    duplicated.insert_str(duplicate_position, ",\"deviceId\":\"review-device-id\"");
    duplicated.push('\n');
    server.write_raw(duplicated.as_bytes());
    retention_authority_assert_error(&server.response(9), -32602);

    // A private request without an id is a notification, never an executable operation.
    let no_id = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "method": "attachment/retention/reserve",
        "params": {
            "trustedContext": context.clone(),
            "clientRequestId": "review-no-id",
            "threadId": "abcde",
            "stageRefs": [],
        },
        "kcoderPrivateRetention": retention_authority_extension(&context),
    }))
    .unwrap();
    let mut no_id_frame = no_id;
    no_id_frame.push(b'\n');
    server.write_raw(&no_id_frame);
    server.send(json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "thread/list",
        "params": {},
    }));
    assert!(server.response(10).get("error").is_none());

    assert_eq!(
        retention_authority_snapshot(&retention_root).unwrap(),
        baseline,
        "authorized-but-unwired, rejected, duplicate-key, and no-id requests must not mutate retention files"
    );
    retention_authority_assert_no_owner_records(&retention_root);
    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_account_parent_binds_actual_uid_and_fixed_config_root() {
    let temp = tempfile::tempdir().unwrap();
    let fixture_a = retention_authority_fixture(&temp, "workspace-a");
    let principal_id = "review-authenticated-account";
    let uid = retention_authority_uid();
    let retention_root = fixture_a.config.join("attachment-retention-v1");
    let mut server = RetentionAuthorityServer::spawn(
        &fixture_a,
        &retention_authority_account_args(principal_id, uid),
    );
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_ne!(
        initialized["result"]["capabilities"]["experimental"]["stagedAttachmentRetentionReceiptsV1"],
        true
    );
    assert!(retention_root.is_dir());
    retention_authority_assert_private_account_root(&retention_root, uid);
    assert!(
        !fixture_a
            .workspace
            .join("client-sessions/attachment-retention-v1")
            .exists()
    );

    let baseline = retention_authority_snapshot(&retention_root).unwrap();
    let context = retention_authority_account_context(principal_id);
    server.send(retention_authority_request(
        2,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    ));
    retention_authority_assert_error(&server.response(2), -32601);

    let wrong_principal = retention_authority_account_context("different-account");
    server.send(retention_authority_request(
        3,
        "attachment/retention/read",
        &wrong_principal,
        retention_authority_read_params(&wrong_principal),
    ));
    retention_authority_assert_error(&server.response(3), -32001);
    assert_eq!(
        retention_authority_snapshot(&retention_root).unwrap(),
        baseline,
        "principal mismatch must not call or mutate retention service state"
    );
    retention_authority_assert_no_owner_records(&retention_root);
    server.shutdown_successfully();

    // A second workspace using the same trusted account profile reopens the
    // same account store; workspace-specific durable storage cannot mint a root.
    let workspace_b = temp.path().join("workspace-b");
    std::fs::create_dir_all(&workspace_b).unwrap();
    let fixture_b = RetentionAuthorityFixture {
        workspace: workspace_b,
        config: fixture_a.config.clone(),
        settings: fixture_a.settings.clone(),
    };
    let mut second_workspace = RetentionAuthorityServer::spawn(
        &fixture_b,
        &retention_authority_account_args(principal_id, uid),
    );
    let second_initialized = second_workspace.initialize();
    assert!(
        second_initialized.get("error").is_none(),
        "{second_initialized}"
    );
    assert_eq!(
        retention_authority_snapshot(&retention_root).unwrap(),
        baseline,
        "changing only workspace must keep the fixed account-root contents and namespace"
    );
    second_workspace.send(retention_authority_request(
        2,
        "attachment/retention/read",
        &context,
        retention_authority_read_params(&context),
    ));
    retention_authority_assert_error(&second_workspace.response(2), -32601);
    assert_eq!(
        retention_authority_snapshot(&retention_root).unwrap(),
        baseline,
        "a request from the second workspace still cannot create service records"
    );
    second_workspace.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_inherited_local_parent_dispatches_workspace_v2_scope_and_read() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let inherited = retention_authority_local_parent_environment();
    let mut server =
        RetentionAuthorityServer::spawn_with_parent_environment(&fixture, &[], Some(&inherited));

    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workspaceOperationReceiptsV2"], true,
        "a successfully captured inherited parent advertises the actual V2 capability"
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["stagedAttachmentRetentionReceiptsV1"],
        false,
        "V2 parent capture does not open the unfinished attachment lifecycle"
    );

    let context = retention_authority_local_context();
    server.send(retention_authority_workspace_request(
        2,
        "runtime.workspaces.operation/scopeV2",
        &context,
        "target-from-trusted-launch",
        json!({}),
    ));
    let scope_response = server.response(2);
    assert!(scope_response.get("error").is_none(), "{scope_response}");
    assert_eq!(scope_response["result"]["version"], 2);
    let root_id = scope_response["result"]["rootId"]
        .as_str()
        .expect("scopeV2 returns its trusted root fence");
    let scope_id = scope_response["result"]["scopeId"]
        .as_str()
        .expect("scopeV2 returns its account/device scope fence")
        .to_owned();
    assert_eq!(root_id.len(), 64);

    server.send(retention_authority_workspace_request(
        3,
        "runtime.workspaces.operation/readV2",
        &context,
        "target-from-trusted-launch",
        json!({
            "clientRequestId": "startup-scope-read-probe",
            "scopeId": scope_id,
        }),
    ));
    let read_response = server.response(3);
    assert!(read_response.get("error").is_none(), "{read_response}");
    assert_eq!(read_response["result"]["scope"]["rootId"], root_id);
    assert_eq!(read_response["result"]["receipt"], Value::Null);
    assert!(
        !fixture.config.join("workspace-operations-v2").exists(),
        "a read of a missing ID does not create the V2 ledger"
    );
    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_dotenv_parent_fact_cannot_authorize_and_is_absent_in_hook_child() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let inherited_fact = retention_authority_local_parent_environment();
    std::fs::write(
        fixture.config.join(".env"),
        format!("KCODER_PRIVATE_RETENTION_PARENT_V1={inherited_fact}\n"),
    )
    .unwrap();
    let marker = temp.path().join("hook-reserved-key-presence");
    retention_authority_write_session_start_env_probe(&fixture.settings, &marker);

    // The test runner's environment is scrubbed by the fixture; only this
    // profile .env attempts to declare a parent fact.
    let mut server = RetentionAuthorityServer::spawn(&fixture, &[]);
    let initialized = server.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workspaceOperationReceiptsV2"],
        false,
        ".env is loaded after the OS-parent fact was captured and cannot authorize"
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {},
    }));
    assert!(server.response(2).get("error").is_none());
    retention_authority_wait_for_file(&marker, "absent");
    assert!(
        !fixture.config.join("attachment-retention-v1").exists(),
        "dotenv-only parent input did not open a retention store"
    );
    server.shutdown_successfully();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_optional_symlink_capture_failure_falls_back_but_matching_flags_stay_strict()
{
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let retention_root = fixture.config.join("attachment-retention-v1");
    assert!(!retention_root.exists());
    let sentinel = temp.path().join("retention-sentinel");
    std::fs::create_dir(&sentinel).unwrap();
    std::fs::set_permissions(&sentinel, std::fs::Permissions::from_mode(0o700)).unwrap();
    let sentinel_file = sentinel.join("sentinel.bin");
    let sentinel_bytes = b"must remain outside the retention store".to_vec();
    std::fs::write(&sentinel_file, &sentinel_bytes).unwrap();
    let sentinel_metadata = std::fs::metadata(&sentinel).unwrap();
    let sentinel_identity = (sentinel_metadata.dev(), sentinel_metadata.ino());
    let sentinel_file_identity = {
        let metadata = std::fs::metadata(&sentinel_file).unwrap();
        (metadata.dev(), metadata.ino())
    };
    symlink(&sentinel, &retention_root).unwrap();
    let link_metadata = std::fs::symlink_metadata(&retention_root).unwrap();
    let link_identity = (link_metadata.dev(), link_metadata.ino());
    let link_target = std::fs::read_link(&retention_root).unwrap();
    let assert_sentinel_unchanged = || {
        let directory = std::fs::metadata(&sentinel).unwrap();
        assert_eq!((directory.dev(), directory.ino()), sentinel_identity);
        let marker = std::fs::metadata(&sentinel_file).unwrap();
        assert_eq!((marker.dev(), marker.ino()), sentinel_file_identity);
        assert_eq!(std::fs::read(&sentinel_file).unwrap(), sentinel_bytes);
        let entries = std::fs::read_dir(&sentinel)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![std::ffi::OsString::from("sentinel.bin")]);
        let link = std::fs::symlink_metadata(&retention_root).unwrap();
        assert!(link.file_type().is_symlink());
        assert_eq!((link.dev(), link.ino()), link_identity);
        assert_eq!(std::fs::read_link(&retention_root).unwrap(), link_target);
    };
    let inherited = retention_authority_local_parent_environment();

    // Keep normal configuration startup intact and make only the retention store
    // root fail its no-follow open.
    let mut optional =
        RetentionAuthorityServer::spawn_with_parent_environment(&fixture, &[], Some(&inherited));
    let initialized = optional.initialize();
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["workspaceOperationReceiptsV2"],
        false,
        "valid inherited facts may fall back only when capture itself is unavailable"
    );
    optional.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/start",
        "params": {},
    }));
    assert!(optional.response(2).get("error").is_none());
    assert_sentinel_unchanged();
    optional.shutdown_successfully();

    let strict = retention_authority_startup_output_with_parent_environment(
        &fixture,
        &retention_authority_local_os_args(),
        Some(&inherited),
    );
    assert!(
        !strict.status.success(),
        "matching explicit flags select strict capture and cannot use inherited optional fallback"
    );
    assert_sentinel_unchanged();
}

#[test]
#[cfg(target_os = "linux")]
fn retention_authority_malformed_uid_conflict_and_flag_conflict_fail_before_store_creation() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = retention_authority_fixture(&temp, "workspace");
    let actual_uid = retention_authority_uid();
    let wrong_uid = if actual_uid == 0 { 1 } else { actual_uid - 1 };
    let local = retention_authority_local_parent_environment();
    let malformed_duplicate = retention_authority_encode_parent_environment(
        r#"{"version":1,"version":1,"mode":"localOs"}"#,
    );
    let wrong_uid_environment = retention_authority_encode_parent_environment(
        &json!({
            "version": 1,
            "mode": "verifiedAccount",
            "principalId": "review-account",
            "uid": wrong_uid,
        })
        .to_string(),
    );
    let conflicting = retention_authority_encode_parent_environment(
        &json!({
            "version": 1,
            "mode": "verifiedAccount",
            "principalId": "review-account",
            "uid": actual_uid,
        })
        .to_string(),
    );

    for (label, parent_args, environment) in [
        (
            "duplicate raw field",
            vec![],
            Some(malformed_duplicate.as_str()),
        ),
        ("UID mismatch", vec![], Some(wrong_uid_environment.as_str())),
        (
            "explicit and inherited facts conflict",
            retention_authority_local_os_args(),
            Some(conflicting.as_str()),
        ),
    ] {
        let output = retention_authority_startup_output_with_parent_environment(
            &fixture,
            &parent_args,
            environment,
        );
        assert!(
            !output.status.success(),
            "{label} must reject startup instead of silently downgrading: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(
            !fixture.config.join("attachment-retention-v1").exists(),
            "{label} must fail before retention-store creation"
        );
    }

    let matching = retention_authority_startup_output_with_parent_environment(
        &fixture,
        &retention_authority_local_os_args(),
        Some(&local),
    );
    assert!(
        matching.status.success(),
        "identical explicit and inherited declarations remain accepted: stdout={} stderr={}",
        String::from_utf8_lossy(&matching.stdout),
        String::from_utf8_lossy(&matching.stderr),
    );
    assert!(
        fixture.config.join("attachment-retention-v1").is_dir(),
        "matching strict declarations capture the real account store"
    );
}
