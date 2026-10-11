fn resume_history_start_thread(server: &mut TestAppServer, request_id: i64) -> String {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "thread/start",
        "params": {}
    }));
    let response = server.response(request_id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"]["thread"]["id"]
        .as_str()
        .expect("thread/start returns a thread id")
        .to_owned()
}

fn resume_history_complete_turn(
    server: &mut TestAppServer,
    request_id: i64,
    thread_id: &str,
    prompt: &str,
) {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [{"type": "text", "text": prompt}]
        }
    }));
    let started = server.response(request_id);
    assert!(started.get("error").is_none(), "{started}");
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
}

fn resume_history_initialize(server: &mut TestAppServer, request_id: i64) {
    let response = server.initialize(request_id);
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"]["capabilities"]["experimental"]["threadResumeHistoryPageV1"], true,
        "the server must explicitly advertise inline resume history: {response}"
    );
}

fn resume_history_request(
    server: &mut TestAppServer,
    request_id: i64,
    thread_id: &str,
    limit: u32,
    indexed: bool,
) -> Value {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "thread/resume",
        "params": {
            "threadId": thread_id,
            "history": {"limit": limit, "indexed": indexed}
        }
    }));
    server.response(request_id)
}

fn resume_history_ready_page<'a>(response: &'a Value, thread_id: &str) -> &'a Value {
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["thread"]["id"], thread_id, "{response}");
    assert_eq!(
        response["result"]["history"]["status"], "ready",
        "a valid offline session must return its actual first page: {response}"
    );
    let page = &response["result"]["history"]["page"];
    assert!(page.is_object(), "{response}");
    assert!(
        page.get("thread").is_none(),
        "the first page must not duplicate the outer Thread: {response}"
    );
    page
}

fn resume_history_read_page(
    server: &mut TestAppServer,
    request_id: i64,
    method: &str,
    thread_id: &str,
    limit: u32,
    before_cursor: Option<&str>,
) -> Value {
    let mut params = json!({"threadId": thread_id, "limit": limit});
    if let Some(cursor) = before_cursor {
        params["beforeCursor"] = json!(cursor);
    }
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params
    }));
    let response = server.response(request_id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

fn resume_history_assert_same_page(inline: &Value, read: &Value) {
    for field in [
        "messages",
        "rangeStart",
        "rangeEnd",
        "hasMoreBefore",
        "beforeCursor",
    ] {
        assert_eq!(
            inline[field], read[field],
            "page field {field}: inline={inline}, read={read}"
        );
    }
}

fn resume_history_assert_same_page_projection(inline: &Value, read: &Value) {
    for field in ["messages", "rangeStart", "rangeEnd", "hasMoreBefore"] {
        assert_eq!(
            inline[field], read[field],
            "page projection field {field}: inline={inline}, read={read}"
        );
    }
}

fn resume_history_refresh_index(server: &mut TestAppServer, request_id: i64) -> Value {
    server.send(json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "thread/history/refresh",
        "params": {"acknowledgeExternalWriters": true}
    }));
    let mut progress = server.response(request_id);
    assert!(progress.get("error").is_none(), "{progress}");
    for step in 1_i64..=64 {
        if progress["result"]["status"] != "building" {
            break;
        }
        let cursor = progress["result"]["nextCursor"]
            .as_str()
            .expect("building history refresh returns its next cursor")
            .to_owned();
        server.send(json!({
            "jsonrpc": "2.0",
            "id": request_id + step,
            "method": "thread/history/refresh",
            "params": {"cursor": cursor}
        }));
        progress = server.response(request_id + step);
        assert!(progress.get("error").is_none(), "{progress}");
    }
    assert_eq!(
        progress["result"]["status"], "ready",
        "actual refresh protocol must establish indexed-read tracking: {progress}"
    );
    progress
}

fn resume_history_message_ids(page: &Value) -> Vec<String> {
    page["messages"]
        .as_array()
        .expect("history page contains a messages array")
        .iter()
        .map(|message| {
            message["id"]
                .as_str()
                .expect("visible transcript row has an id")
                .to_owned()
        })
        .collect()
}

#[test]
fn thread_resume_history_is_additive_for_resident_cold_and_legacy_requests() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut owner =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut owner, 1);
    let thread_id = resume_history_start_thread(&mut owner, 2);
    resume_history_complete_turn(&mut owner, 3, &thread_id, "resume history fixture");
    let baseline = resume_history_read_page(&mut owner, 4, "thread/read", &thread_id, 50, None);

    let resident = resume_history_request(&mut owner, 5, &thread_id, 50, false);
    let resident_page = resume_history_ready_page(&resident, &thread_id);
    resume_history_assert_same_page(resident_page, &baseline);

    owner.send(json!({
        "jsonrpc": "2.0",
        "id": 6,
        "method": "thread/resume",
        "params": {"threadId": thread_id}
    }));
    let legacy_shape = owner.response(6);
    assert!(legacy_shape.get("error").is_none(), "{legacy_shape}");
    assert_eq!(legacy_shape["result"]["thread"]["id"], thread_id);
    assert!(
        legacy_shape["result"].get("history").is_none(),
        "legacy resume requests keep the original Thread-only result: {legacy_shape}"
    );
    owner.shutdown_successfully();

    let mut cold = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut cold, 1);
    let restored = resume_history_request(&mut cold, 2, &thread_id, 50, false);
    let restored_page = resume_history_ready_page(&restored, &thread_id);
    resume_history_assert_same_page(restored_page, &baseline);
    assert_eq!(
        resume_history_message_ids(restored_page),
        resume_history_message_ids(&baseline)
    );
    cold.shutdown_successfully();
}

#[test]
fn indexed_inline_resume_page_and_opaque_cursor_match_real_stdio_pages() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut owner =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut owner, 1);
    let thread_id = resume_history_start_thread(&mut owner, 2);

    // Each local mock turn contributes a visible user row and assistant row.
    // Thirty completed turns provide more than one 50-row history page without
    // using a Provider or writing a hand-built history fixture.
    for index in 0..30 {
        resume_history_complete_turn(
            &mut owner,
            10 + index * 2,
            &thread_id,
            &format!("indexed resume page fixture {index:02}"),
        );
    }
    let before_shutdown =
        resume_history_read_page(&mut owner, 100, "thread/read", &thread_id, 100, None);
    assert!(
        before_shutdown["messages"].as_array().unwrap().len() > 50,
        "the real offline transcript must span more than one page: {before_shutdown}"
    );
    owner.shutdown_successfully();

    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut server, 1);
    let refreshed = resume_history_refresh_index(&mut server, 10);
    assert_eq!(refreshed["result"]["status"], "ready", "{refreshed}");

    // A real indexed read before resume proves both history and client metadata
    // tracking were activated by the explicit refresh protocol.
    let indexed_before_resume = resume_history_read_page(
        &mut server,
        100,
        "thread/read/indexed",
        &thread_id,
        50,
        None,
    );
    assert_eq!(
        indexed_before_resume["messages"].as_array().unwrap().len(),
        50,
        "{indexed_before_resume}"
    );
    let pre_resume_cursor = indexed_before_resume["beforeCursor"]
        .as_str()
        .expect("refreshed indexed read exposes its actual cursor");
    assert!(
        pre_resume_cursor.starts_with("tp1:"),
        "refresh-ready tracked history must use its opaque indexed cursor: {indexed_before_resume}"
    );

    let inline = resume_history_request(&mut server, 101, &thread_id, 50, true);
    let first_page = resume_history_ready_page(&inline, &thread_id).clone();
    assert_eq!(
        first_page["messages"].as_array().unwrap().len(),
        50,
        "{inline}"
    );
    assert_eq!(
        first_page["rangeEnd"].as_u64().unwrap() - first_page["rangeStart"].as_u64().unwrap(),
        50,
        "{inline}"
    );
    assert_eq!(first_page["hasMoreBefore"], true, "{inline}");
    let cursor = first_page["beforeCursor"]
        .as_str()
        .expect("indexed first page returns an opaque cursor")
        .to_owned();
    assert!(
        cursor.starts_with("tp1:"),
        "advertised indexed history must retain its indexed cursor: {cursor}"
    );

    resume_history_assert_same_page_projection(&first_page, &indexed_before_resume);
    let indexed_first = resume_history_read_page(
        &mut server,
        102,
        "thread/read/indexed",
        &thread_id,
        50,
        None,
    );
    resume_history_assert_same_page(&first_page, &indexed_first);
    let older = resume_history_read_page(
        &mut server,
        103,
        "thread/read/indexed",
        &thread_id,
        50,
        Some(&cursor),
    );
    assert_eq!(older["rangeEnd"], first_page["rangeStart"], "{older}");
    assert!(older["rangeStart"].as_u64().unwrap() < older["rangeEnd"].as_u64().unwrap());

    let mut ids = resume_history_message_ids(&first_page);
    let older_ids = resume_history_message_ids(&older);
    let combined_len = ids.len() + older_ids.len();
    ids.extend(older_ids);
    ids.sort();
    ids.dedup();
    assert_eq!(
        ids.len(),
        combined_len,
        "adjacent actual cursor pages must not overlap"
    );
    server.shutdown_successfully();
}

#[cfg(unix)]
struct ResumeHistoryLeafSwap {
    leaf: std::path::PathBuf,
    backup: std::path::PathBuf,
    marker_contents: &'static str,
    original_dev: u64,
    original_ino: u64,
    active: bool,
}

#[cfg(unix)]
impl ResumeHistoryLeafSwap {
    fn replace_with_directory(leaf: &std::path::Path) -> std::io::Result<Self> {
        use std::os::unix::fs::MetadataExt;

        let backup = leaf.with_file_name(format!(
            "{}.resume-history-review-backup",
            leaf.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("history")
        ));
        if backup.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "resume history review backup already exists",
            ));
        }
        let original_metadata = std::fs::symlink_metadata(leaf)?;
        if !original_metadata.file_type().is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "resume history leaf is not a regular file",
            ));
        }
        let original_dev = original_metadata.dev();
        let original_ino = original_metadata.ino();
        std::fs::rename(leaf, &backup)?;
        if let Err(error) = std::fs::create_dir(leaf) {
            let _ = std::fs::rename(&backup, leaf);
            return Err(error);
        }
        let marker_contents = "resume-history-review-owned-directory";
        if let Err(error) = std::fs::write(leaf.join(".review-owner"), marker_contents) {
            let _ = std::fs::remove_dir_all(leaf);
            let _ = std::fs::rename(&backup, leaf);
            return Err(error);
        }
        Ok(Self {
            leaf: leaf.to_path_buf(),
            backup,
            marker_contents,
            original_dev,
            original_ino,
            active: true,
        })
    }

    fn restore(&mut self) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;

        if !self.active {
            return Ok(());
        }
        let marker = self.leaf.join(".review-owner");
        if !self.leaf.is_dir()
            || std::fs::read_to_string(&marker).ok() != Some(self.marker_contents.to_owned())
        {
            return Err(std::io::Error::other(
                "resume history leaf no longer contains the owned replacement directory",
            ));
        }
        let backup_metadata = std::fs::symlink_metadata(&self.backup)?;
        if !backup_metadata.file_type().is_file()
            || backup_metadata.dev() != self.original_dev
            || backup_metadata.ino() != self.original_ino
        {
            return Err(std::io::Error::other(
                "resume history backup no longer has the original file identity",
            ));
        }
        std::fs::remove_dir_all(&self.leaf)?;
        std::fs::rename(&self.backup, &self.leaf)?;
        self.active = false;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for ResumeHistoryLeafSwap {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

#[cfg(unix)]
fn resume_history_wait_for_path(path: &std::path::Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    path.exists()
}

#[cfg(unix)]
fn resume_history_shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(unix)]
fn resume_history_write_user_session_start_hook(config_dir: &std::path::Path, command: String) {
    std::fs::create_dir_all(config_dir).unwrap();
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::to_vec(&json!({
            "hooks": {
                "SessionStart": [{
                    "hooks": [{
                        "type": "command",
                        "shell": "sh",
                        "timeout": 5,
                        "command": command
                    }]
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
#[cfg(unix)]
fn failed_inline_history_read_keeps_activated_thread_and_can_be_read_after_source_restore() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut owner =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut owner, 1);
    let thread_id = resume_history_start_thread(&mut owner, 2);
    resume_history_complete_turn(
        &mut owner,
        3,
        &thread_id,
        "preserve history after read failure",
    );
    let baseline = resume_history_read_page(&mut owner, 4, "thread/read", &thread_id, 50, None);
    let expected_ids = resume_history_message_ids(&baseline);
    owner.shutdown_successfully();

    let history_path = wait_for_named_file(
        temp.path(),
        &format!("{thread_id}.jsonl"),
        Duration::from_secs(5),
    )
    .expect("completed offline thread has a durable JSONL history");
    let entered = temp.path().join("resume-history-hook-entered");
    let release = temp.path().join("resume-history-hook-release");
    let user_config = temp.path().join("config");
    resume_history_write_user_session_start_hook(
        &user_config,
        format!(
            "printf entered > {}; while [ ! -e {} ]; do sleep 0.01; done",
            resume_history_shell_quote(&entered),
            resume_history_shell_quote(&release)
        ),
    );

    let mut resumed = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut resumed, 1);
    resumed.send(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "thread/resume",
        "params": {
            "threadId": thread_id,
            "history": {"limit": 50, "indexed": false}
        }
    }));
    assert!(
        resume_history_wait_for_path(&entered, Duration::from_secs(3)),
        "the persisted runtime must reach its startup hook after activation"
    );
    let mut swapped = ResumeHistoryLeafSwap::replace_with_directory(&history_path).unwrap();
    std::fs::write(&release, b"release").unwrap();
    let unavailable = resumed.response(2);
    swapped.restore().unwrap();

    assert!(unavailable.get("error").is_none(), "{unavailable}");
    assert_eq!(
        unavailable["result"]["thread"]["id"], thread_id,
        "{unavailable}"
    );
    assert_eq!(
        unavailable["result"]["history"]["status"], "unavailable",
        "a post-activation read failure must preserve successful activation: {unavailable}"
    );
    assert_eq!(
        unavailable["result"]["history"]["code"], "readFailed",
        "the result must distinguish a real history read failure: {unavailable}"
    );
    assert!(
        unavailable["result"]["history"].get("page").is_none(),
        "a read failure must not be represented as an empty page: {unavailable}"
    );

    let after_restore =
        resume_history_read_page(&mut resumed, 3, "thread/read", &thread_id, 50, None);
    assert_eq!(
        resume_history_message_ids(&after_restore),
        expected_ids,
        "restoring the same history inode makes the already resident thread readable again"
    );
    resumed.shutdown_successfully();
}

#[test]
#[cfg(unix)]
fn invalid_inline_history_limits_are_rejected_before_cold_resume_activation() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut owner =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut owner, 1);
    let thread_id = resume_history_start_thread(&mut owner, 2);
    resume_history_complete_turn(&mut owner, 3, &thread_id, "invalid history limits fixture");
    let _ = resume_history_read_page(&mut owner, 4, "thread/read", &thread_id, 50, None);
    owner.shutdown_successfully();

    let marker = temp.path().join("invalid-limit-session-start");
    let user_config = temp.path().join("config");
    resume_history_write_user_session_start_hook(
        &user_config,
        format!("printf x >> {}", resume_history_shell_quote(&marker)),
    );

    let mut cold = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut cold, 1);
    for (request_id, limit) in [(2, 0), (3, 101)] {
        let rejected = resume_history_request(&mut cold, request_id, &thread_id, limit, false);
        assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
        assert!(
            rejected.get("result").is_none(),
            "invalid history options must be rejected before activation: {rejected}"
        );
        assert!(
            !marker.exists(),
            "invalid request with limit={limit} must not run the cold-resume startup hook"
        );
    }

    let legal = resume_history_request(&mut cold, 4, &thread_id, 50, false);
    let page = resume_history_ready_page(&legal, &thread_id);
    assert!(
        !resume_history_message_ids(page).is_empty(),
        "a legal retry after invalid options still activates the original persisted thread"
    );
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "x",
        "the startup hook runs once when the first valid cold resume activates the thread"
    );
    cold.shutdown_successfully();
}

#[test]
fn active_lease_error_is_not_recast_as_unavailable_inline_history() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut owner =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut owner, 1);
    let thread_id = resume_history_start_thread(&mut owner, 2);
    resume_history_complete_turn(
        &mut owner,
        3,
        &thread_id,
        "lease error is an activation failure",
    );
    let _ = resume_history_read_page(&mut owner, 4, "thread/read", &thread_id, 50, None);

    let mut contender = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut contender, 1);
    let rejected = resume_history_request(&mut contender, 2, &thread_id, 50, false);
    assert_eq!(rejected["error"]["code"], -32022, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("already active"),
        "the live lease remains the cause of the activation error: {rejected}"
    );
    assert!(
        rejected.get("result").is_none(),
        "activation errors do not return an Unavailable history result: {rejected}"
    );
    contender.shutdown_successfully();
    owner.shutdown_successfully();
}

#[test]
fn resident_capacity_error_is_not_recast_as_unavailable_inline_history() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);

    let mut creator =
        TestAppServer::start_scenario(temp.path(), &settings, "thinking-preview", "0", "0", "0");
    resume_history_initialize(&mut creator, 1);
    let persisted_id = resume_history_start_thread(&mut creator, 2);
    resume_history_complete_turn(&mut creator, 3, &persisted_id, "capacity error fixture");
    let _ = resume_history_read_page(&mut creator, 4, "thread/read", &persisted_id, 50, None);
    creator.shutdown_successfully();

    let mut full = TestAppServer::builder(temp.path(), &settings)
        .resident_limit(1)
        .stream_delay_ms("0")
        .without_scenario()
        .spawn();
    resume_history_initialize(&mut full, 1);
    let active_id = resume_history_start_thread(&mut full, 2);
    let rejected = resume_history_request(&mut full, 3, &persisted_id, 50, false);
    assert_ne!(active_id, persisted_id);
    assert_eq!(rejected["error"]["code"], -32039, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("capacity"),
        "the resident slot failure remains an activation error: {rejected}"
    );
    assert!(
        rejected.get("result").is_none(),
        "capacity errors do not return an Unavailable history result: {rejected}"
    );
    full.shutdown_successfully();
}
