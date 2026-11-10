//! Real stdio reads remain scoped and never initialize or repair work storage.
use super::*;
use std::{
    collections::BTreeMap,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Directory(String),
    File(kcoder_config::PortableLeaseIdentity, Vec<u8>),
}

fn snapshot(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, Entry>> {
    fn visit(
        root: &Path,
        path: &Path,
        output: &mut BTreeMap<PathBuf, Entry>,
    ) -> anyhow::Result<()> {
        let relative = path.strip_prefix(root)?.to_owned();
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "unexpected fixture link"
        );
        if metadata.is_dir() {
            let directory = kcoder_config::PrivateDirectory::open_existing(path)?;
            output.insert(relative, Entry::Directory(directory.directory_identity()?));
            for child in std::fs::read_dir(path)? {
                visit(root, &child?.path(), output)?;
            }
        } else {
            anyhow::ensure!(metadata.is_file(), "unexpected fixture entry");
            let file = std::fs::File::open(path)?;
            let identity = kcoder_config::PortableLeaseIdentity::from_regular_handle(&file)?;
            let digest = Sha256::digest(std::fs::read(path)?).to_vec();
            output.insert(relative, Entry::File(identity, digest));
        }
        Ok(())
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output)?;
    Ok(output)
}

#[test]
#[ignore = "requires a private profile, masked personal ancestors and isolated loopback"]
fn unverified_work_scope_stays_closed_without_affecting_ordinary_session() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let requests = temp.path().join("recorded-requests");
    std::fs::create_dir(&requests).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    let specs = workspace.join(".kcoder/specs");
    std::fs::create_dir_all(&specs).unwrap();
    std::fs::write(
        specs.join("config.yaml"),
        "schema: kcoder-spec-driven-superpowers\n",
    )
    .unwrap();
    let orphan = workspace.join(".kcoder/orchestrate/works/owned-orphan");
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(
        orphan.join("plan.md"),
        b"owned orphan must remain unchanged",
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = listener.local_addr().unwrap();
    // The fixture must be able to observe a connection before zero means zero.
    let probe = TcpStream::connect(endpoint).unwrap();
    let (accepted, _) = listener.accept().unwrap();
    drop((probe, accepted));
    listener.set_nonblocking(true).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(false);
    value["providers"]["integration-test"]["endpoint"] = json!(format!("http://{endpoint}/v1"));
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("markdown-showcase")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TUI_LAB_REQUEST_DIR", &requests)
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27", "clientInfo":{"name":"work-scope-owned","version":"1"},
            "capabilities":{"experimental":{"continuousWorkV1":true,"continuousWorkReadV1":true,"integrationScopeV1":false}}
        }}),
    );
    let initialized = server.response(1);
    assert!(initialized.get("error").is_none(), "{initialized}");
    assert_ne!(
        initialized["result"]["capabilities"]["experimental"]["continuousWorkV1"],
        true
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["continuousWorkReadV1"],
        true
    );

    assert_ne!(
        initialized["result"]["capabilities"]["experimental"]["integrationScopeV1"],
        true
    );

    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let started = server.response(2);
    let thread = started["result"]["thread"]["id"]
        .as_str()
        .expect("ordinary thread starts");
    // Workspace startup schedules this three-file publication in the background.
    // Its full snapshot is published last; observe it before measuring the Work requests.
    let snapshot_dir = config.join("shell_snapshots");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let complete = std::fs::read_dir(&snapshot_dir)
            .ok()
            .is_some_and(|entries| {
                entries.flatten().any(|entry| {
                    let path = entry.path();
                    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                        return false;
                    };
                    let Some(stem) = name.strip_suffix(".sh") else {
                        return false;
                    };
                    !stem.ends_with(".verifier")
                        && !stem.ends_with(".sandbox")
                        && snapshot_dir.join(format!("{stem}.verifier.sh")).is_file()
                        && snapshot_dir.join(format!("{stem}.sandbox.sh")).is_file()
                        && path.is_file()
                })
            });
        if complete {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "owned shell snapshot did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let original = snapshot(temp.path()).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"work/list","params":{}}));
    assert_eq!(server.response(3)["result"]["items"], json!([]));
    server.send(
        json!({"jsonrpc":"2.0","id":4,"method":"work/read","params":{"workId":"owned-work"}}),
    );
    assert_eq!(server.response(4)["result"]["presence"], "confirmed_absent");
    for (id, method, params) in [
        (
            5,
            "work/list",
            json!({"accountId":"forged-account","targetId":"forged-target","workspace":"forged-workspace"}),
        ),
        (
            6,
            "work/read",
            json!({"workId":"owned-work","threadId":"forged-thread"}),
        ),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        assert_eq!(server.response(id)["error"]["code"], -32602);
    }
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"work/read",
        "params":{"workId":"owned-work"},"kcoderPrivateRetention":{"version":1}}));
    assert_eq!(server.response(7)["error"]["code"], -32001);
    let after = snapshot(temp.path()).unwrap();
    let changed: Vec<_> = original
        .keys()
        .chain(after.keys())
        .filter(|path| original.get(*path) != after.get(*path))
        .collect();
    assert!(changed.is_empty(), "fixture paths changed: {changed:?}");
    assert!(!config.join("continuous-work.v1").exists());
    assert_eq!(std::fs::read_dir(&requests).unwrap().count(), 0);
    server
        .send(json!({"jsonrpc":"2.0","id":8,"method":"thread/read","params":{"threadId":thread}}));
    let read = server.response(8);
    assert_eq!(read["error"]["code"], -32021, "{read}");
    assert_eq!(
        read["error"]["message"], "session history is disabled",
        "{read}"
    );
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"turn/start",
        "params":{"threadId":thread,"input":[{"type":"text","text":"owned fixture ordinary turn"}]}}));
    let deadline = Instant::now() + Duration::from_secs(30);
    let (mut accepted, mut completed) = (false, false);
    while !(accepted && completed) {
        let message = server.next_value(deadline);
        if message["id"] == 9 {
            assert!(message.get("error").is_none(), "{message}");
            accepted = true;
        }
        if message["method"] == "turn/completed" {
            assert_eq!(message["params"]["threadId"], thread);
            assert_eq!(message["params"]["turn"]["status"], "completed");
            completed = true;
        }
    }
    assert!(requests.join("request_001.json").is_file());
    drop(server.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success(), "owned app-server exited unsuccessfully");
            break;
        }
        assert!(Instant::now() < deadline, "owned app-server did not stop");
        std::thread::sleep(Duration::from_millis(20));
    }

    // The same real app-server must also read an accepted persistent task
    // without exposing an otherwise identical record from another account.
    value["history_enabled"] = json!(true);
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut persistent_builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("markdown-showcase")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TRUST_ALL", "0");
    persistent_builder.training_mode = true;
    let mut persistent = persistent_builder.spawn();
    persistent.send(
        json!({"jsonrpc":"2.0","id":10,"method":"initialize","params":{
            "protocolVersion":"2026-07-27", "clientInfo":{"name":"work-read-owned","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true,"continuousWorkPartialListV1":true}}
        }}),
    );
    let persistent_init = persistent.response(10);
    assert_eq!(
        persistent_init["result"]["capabilities"]["experimental"]["continuousWorkReadV1"],
        true
    );
    assert_eq!(
        persistent_init["result"]["capabilities"]["experimental"]["continuousWorkPartialListV1"],
        true
    );
    persistent.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/start","params":{}}));
    let persistent_thread = persistent.response(11)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    persistent.send(
        json!({"jsonrpc":"2.0","id":12,"method":"turn/start","params":{
            "threadId":persistent_thread,"input":[{"type":"text","text":"owned task"}]
        }}),
    );
    let turn = persistent.response(12);
    let turn_id = turn["result"]["turn"]["id"].as_str().unwrap();
    let attempt_id = turn["result"]["turn"]["attemptId"].as_str().unwrap();
    persistent.wait_for_method("turn/completed");
    let host =
        kcoder_state::continuous_work::HostWorkScope::capture(&config, &workspace, None).unwrap();
    let store =
        kcoder_state::continuous_work::ContinuousWorkStore::open_or_create(&config).unwrap();
    let source = kcoder_state::continuous_work::WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-host".into(),
        conversation_id: persistent_thread.clone(),
    };
    let initial = |scope: &kcoder_types::continuous_work::WorkScope, work_id: &str| {
        serde_json::from_value::<kcoder_types::continuous_work::WorkRecord>(json!({
            "schemaVersion":1,"identity":{"scope":scope,"workId":work_id},
            "origin":{"kind":"foreground","initialAttempt":{"threadId":persistent_thread,"turnId":turn_id,"attemptId":attempt_id}},
            "linkedThreadIds":[persistent_thread],"phase":"pending",
            "revision":{"revision":1,"requirementsRevision":1,"controlEpoch":0,"ownerEpoch":0,
                "acceptedInputSequence":1,"requiredInputSequence":1,"appliedInputSequence":0}
        })).unwrap()
    };
    let actual = host.scope().clone();
    store
        .admit(
            &actual,
            initial(&actual, "work-owned"),
            &source,
            "owned-input",
            json!({"text":"owned task"}),
            vec![],
        )
        .unwrap();
    let mut unreadable = initial(&actual, "work-unreadable");
    unreadable.origin.initial_attempt.thread_id = "missing-thread".into();
    unreadable.linked_thread_ids = vec!["missing-thread".into()];
    let mut unreadable_source = source.clone();
    unreadable_source.conversation_id = "missing-thread".into();
    store
        .admit(
            &actual,
            unreadable,
            &unreadable_source,
            "unreadable-input",
            json!({"text":"unreadable task"}),
            vec![],
        )
        .unwrap();
    let mut foreign = actual.clone();
    foreign.account_id = "foreign-account".into();
    store
        .admit(
            &foreign,
            initial(&foreign, "work-foreign"),
            &source,
            "foreign-input",
            json!({"text":"foreign task"}),
            vec![],
        )
        .unwrap();
    let before_work = snapshot(&config.join("continuous-work.v1")).unwrap();
    persistent.send(
        json!({"jsonrpc":"2.0","id":13,"method":"work/read","params":{"workId":"work-owned"}}),
    );
    let read = persistent.response(13);
    assert_eq!(
        read["result"]["work"]["threadId"], persistent_thread,
        "{read}"
    );
    assert_eq!(read["result"]["work"]["freshness"], "partial", "{read}");
    persistent
        .send(json!({"jsonrpc":"2.0","id":14,"method":"work/list","params":{"allowPartial":true}}));
    let list = persistent.response(14);
    assert_eq!(
        list["result"]["items"].as_array().unwrap().len(),
        1,
        "{list}"
    );
    assert_eq!(list["result"]["partial"], true, "{list}");
    persistent.send(
        json!({"jsonrpc":"2.0","id":16,"method":"work/read","params":{"workId":"work-unreadable"}}),
    );
    assert_eq!(persistent.response(16)["result"]["presence"], "unreadable");
    persistent.send(
        json!({"jsonrpc":"2.0","id":15,"method":"work/read","params":{"workId":"work-foreign"}}),
    );
    assert_eq!(
        persistent.response(15)["result"]["presence"],
        "confirmed_absent"
    );
    assert_eq!(
        before_work,
        snapshot(&config.join("continuous-work.v1")).unwrap()
    );
    persistent.shutdown_successfully();
    let mut legacy_builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("markdown-showcase")
        .discard_stderr();
    legacy_builder.training_mode = true;
    let mut legacy = legacy_builder.spawn();
    legacy.send(json!({"id":17,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"work-read-legacy","version":"1"},
        "capabilities":{"experimental":{"continuousWorkReadV1":true}}
    }}));
    let legacy_init = legacy.response(17);
    assert_ne!(
        legacy_init["result"]["capabilities"]["experimental"]["continuousWorkPartialListV1"],
        true
    );
    legacy.send(json!({"id":18,"method":"work/list","params":{}}));
    assert!(legacy.response(18)["error"].is_object());
    legacy.shutdown_successfully();
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "an unexpected model connection occurred"
    );
}

#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn explicit_goal_binds_the_actual_user_input_without_creating_work_for_chat() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let mcp = temp.path().join("mcp");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&mcp).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    value["goal_max_auto_continuations"] = json!(0);
    let mcp_fixture = std::path::Path::new(env!("KCODER_WORKSPACE_ROOT"))
        .join("crates/kcoder_mcp/tests/fixtures/apps_server.py");
    value["tools"] = json!({"profile":"full"});
    value["mcp_servers"] = json!([{"name":"owned-server","transport":"stdio","command":"python3","args":[mcp_fixture,"normal",mcp]}]);
    value["session_memory"] = json!({"enabled":false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("goal-pro")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"work-admission-owned","version":"1"},
        "capabilities":{"experimental":{"continuousWorkReadV1":true,"integrationScopeV1":true,"taskSourcesV1":true}}
    }}));
    let initialized = server.response(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["continuousWorkReadV1"],
        true
    );
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["taskSourcesV1"], true,
        "{initialized}"
    );
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let chat = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":chat,"input":[{"type":"text","text":"hello"}]}}));
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");
    server.send(json!({"id":4,"method":"work/list","params":{}}));
    assert_eq!(server.response(4)["result"]["items"], json!([]));
    assert!(!config.join("continuous-work.v1").exists());

    server.send(json!({"id":5,"method":"thread/start","params":{}}));
    let thread = server.response(5)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let original = "continuous-work-fixture-request: please complete this task";
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNwaDgARAwHGhyACAAqDgYBxIhtdAAAAABJRU5ErkJggg==";
    server.send(json!({"id":50,"method":"attachment/save","params":{
        "filename":"work-image.png","content_base64":image
    }}));
    let staged = server.response(50)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let prompt = format!(
        "{original}\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({"filename":"work-image.png","path":staged,"mimeType":"image/png"})
    );
    server.send(json!({"id":6,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":prompt}]}}));
    assert!(server.response(6).get("error").is_none());
    server.wait_for_method("turn/completed");
    let deadline = Instant::now() + Duration::from_secs(15);
    let work_id = loop {
        server.send(json!({"id":7,"method":"work/list","params":{}}));
        let page = server.response(7);
        if let Some(work) = page["result"]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["threadId"] == thread))
        {
            break work["workId"].as_str().unwrap().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "real input was not bound to a work record: {page}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let host =
        kcoder_state::continuous_work::HostWorkScope::capture(&config, &workspace, None).unwrap();
    let store = kcoder_state::continuous_work::ContinuousWorkStore::open_existing(&config)
        .unwrap()
        .unwrap();
    let work = store.read_work(host.scope(), &work_id).unwrap().unwrap();
    let inputs = store.list_inputs(host.scope(), &work_id, None).unwrap();
    assert_eq!(inputs.inputs.len(), 1);
    let entry = &inputs.inputs[0];
    assert_eq!(work.revision.applied_input_sequence, 1);
    assert_eq!(
        entry.receipt.state,
        kcoder_types::continuous_work::WorkInputState::Applied
    );
    assert_eq!(
        entry.applied.as_ref().unwrap().attempt,
        work.origin.initial_attempt
    );
    assert_eq!(
        entry.applied.as_ref().unwrap().history_uuid,
        entry.receipt.input_id
    );
    let (_, payload) = store
        .read_input(
            host.scope(),
            &work_id,
            &entry.source,
            &entry.receipt.input_id,
        )
        .unwrap()
        .unwrap();
    let content = payload["content"].as_array().unwrap();
    assert!(content[0]["text"].as_str().unwrap().starts_with(original));
    assert!(content.iter().any(|block| {
        block["type"] == "image"
            && block["source"]["media_type"] == "image/png"
            && block["source"]["data"] == image
    }));
    assert_eq!(work.origin.initial_attempt.thread_id, thread);
    assert!(work.native_refs.iter().any(|reference| matches!(
        reference,
        kcoder_types::continuous_work::WorkNativeReference::Known(
            kcoder_types::continuous_work::WorkKnownReference::Goal { .. }
        )
    )));
    assert!(work.native_refs.iter().any(|reference| matches!(reference,
        kcoder_types::continuous_work::WorkNativeReference::Known(
            kcoder_types::continuous_work::WorkKnownReference::TaskCapabilityScope { initial_attempt, accepted_task_key }
        ) if *initial_attempt == work.origin.initial_attempt && accepted_task_key.len() == 64)));
    server.send(json!({"id":8,"method":"integrations/scope/read","params":{}}));
    let scope = server.response(8)["result"].clone();
    let target = json!({"initialAttempt":work.origin.initial_attempt});
    server.send(json!({"id":9,"method":"integrations/tasks/readTaskSources","params":{
        "contractVersion":"parallel-v1","requestId":"source-read","scope":scope,"timeoutMs":10000,
        "payload":{"target":target,"params":{"threadId":thread}}
    }}));
    let sources = server.response(9);
    assert_eq!(sources["result"]["status"], "completed", "{sources}");
    assert!(
        !sources["result"]["result"]["effectiveSources"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{sources}"
    );
    let followup = "Also include the current source references.";
    server.send(json!({"id":10,"method":"turn/start","params":{
        "threadId":thread,"clientMessageId":"owned-followup-1",
        "input":[{"type":"text","text":followup}]
    }}));
    let followup_turn = server.response(10);
    assert!(followup_turn.get("error").is_none(), "{followup_turn}");
    server.wait_for_method("turn/completed");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let updated = store.read_work(host.scope(), &work_id).unwrap().unwrap();
        if updated.revision.applied_input_sequence == 2 {
            assert_eq!(updated.revision.requirements_revision, 2);
            assert!(
                updated.presentation.as_ref().unwrap().updated_at_ms
                    > work.presentation.as_ref().unwrap().updated_at_ms
            );
            break;
        }
        assert!(Instant::now() < deadline, "follow-up input was not applied");
        std::thread::sleep(Duration::from_millis(50));
    }
    let inputs = store.list_inputs(host.scope(), &work_id, None).unwrap();
    assert_eq!(inputs.inputs.len(), 2);
    let second = &inputs.inputs[1];
    assert_eq!(
        second.receipt.state,
        kcoder_types::continuous_work::WorkInputState::Applied
    );
    let (_, payload) = store
        .read_input(
            host.scope(),
            &work_id,
            &second.source,
            &second.receipt.input_id,
        )
        .unwrap()
        .unwrap();
    assert_eq!(payload["text"], followup);
    assert_eq!(payload["acceptedAttempt"]["threadId"], thread);
    assert_eq!(
        payload["acceptedAttempt"]["turnId"],
        followup_turn["result"]["turn"]["id"]
    );
    let mut large_image = super::png_image_fixture();
    large_image.resize(3_300_000, 0);
    server.send(json!({"id":20,"method":"attachment/upload/start","params":{
        "filename":"large.png","size":large_image.len()
    }}));
    let upload = server.response(20)["result"]["upload_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (index, chunk) in large_image.chunks(192 * 1024).enumerate() {
        let id = 21 + index as i64;
        server.send(json!({"id":id,"method":"attachment/upload/chunk","params":{
            "upload_id":upload,"index":index,
            "content_base64":base64::engine::general_purpose::STANDARD.encode(chunk)
        }}));
        assert_eq!(server.response(id)["result"]["accepted"], true);
    }
    server.send(json!({"id":70,"method":"attachment/upload/finish","params":{"upload_id":upload}}));
    let large_path = server.response(70)["result"]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let large_prompt = format!(
        "Also inspect this image.\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        json!({"filename":"large.png","path":large_path,"mimeType":"image/png"})
    );
    server.send(json!({"id":71,"method":"turn/start","params":{
        "threadId":thread,"clientMessageId":"owned-followup-2",
        "input":[{"type":"text","text":large_prompt}]
    }}));
    let large_turn = server.response(71);
    assert!(large_turn.get("error").is_none(), "{large_turn}");
    server.wait_for_method("turn/completed");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if store
            .read_work(host.scope(), &work_id)
            .unwrap()
            .unwrap()
            .revision
            .applied_input_sequence
            == 3
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "large follow-up input was not applied"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let inputs = store.list_inputs(host.scope(), &work_id, None).unwrap();
    let third = &inputs.inputs[2];
    let (_, large_payload) = store
        .read_input(
            host.scope(),
            &work_id,
            &third.source,
            &third.receipt.input_id,
        )
        .unwrap()
        .unwrap();
    let reference = &large_payload["historyRef"];
    let applied = third.applied.as_ref().unwrap();
    assert_eq!(
        large_payload["acceptedAttempt"],
        serde_json::to_value(&applied.attempt).unwrap()
    );
    assert_eq!(reference["historyUuid"], applied.history_uuid);
    assert_eq!(
        reference["attempt"],
        serde_json::to_value(&applied.attempt).unwrap()
    );
    let history = super::wait_for_named_file(
        temp.path(),
        &format!("{thread}.jsonl"),
        Duration::from_secs(5),
    )
    .expect("original conversation history must exist");
    let entries = kcoder_state::load_transcript_history(&history).unwrap();
    let original_entry = entries
        .iter()
        .find(|entry| entry.uuid.as_deref() == Some(applied.history_uuid.as_str()))
        .expect("referenced original message must be retained");
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&original_entry.message).unwrap())
    );
    assert_eq!(reference["messageSha256"], digest);
    let restored: kcoder_types::continuous_work::WorkRecord =
        serde_json::from_value(serde_json::to_value(&work).unwrap()).unwrap();
    assert!(restored.validate_for_mutation(host.scope()).is_ok());
    server.shutdown_successfully();
}

/// A closed dispatch valve must report the wait instead of spending a turn.
///
/// This is the host-level half of CT-12/CT-103: the goal is bound to a work
/// item, the scheduler reaches the shared gate, and the gate refuses to start
/// an automatic continuation. The provider must see no new request, and the
/// client must learn why through the existing continuation notice.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn a_closed_dispatch_valve_reports_the_wait_without_spending_a_turn() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let requests = temp.path().join("recorded-requests");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&requests).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    // A budget of one leaves the automatic continuation allowed, so the refusal
    // can only come from the dispatch valve.
    value["goal_max_auto_continuations"] = json!(1);
    value["continuous_work"] = json!({"dispatch_enabled": false});
    value["session_memory"] = json!({"enabled": false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("goal-pro")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TUI_LAB_REQUEST_DIR", &requests)
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"work-valve","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true}}
        }}),
    );
    assert!(server.response(1).get("error").is_none());

    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[
            {"type":"text","text":"continuous-work-fixture-request: please complete this task"}
        ]}}),
    );
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");

    // The foreground turn must bind the work item before the scheduler can
    // reach the gate at all.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        server.send(json!({"id":4,"method":"work/list","params":{}}));
        let page = server.response(4);
        if page["result"]["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["threadId"] == thread))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the goal input was not bound to a work record: {page}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let requests_before = std::fs::read_dir(&requests).unwrap().count();
    let notice_deadline = Instant::now() + Duration::from_secs(30);
    let notice = loop {
        let frame = server.next_value(notice_deadline);
        if frame["method"] == "thread/goal/continuation"
            && frame["params"]["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("[continuous_work_dispatch_wait]"))
        {
            break frame;
        }
    };
    let reason = notice["params"]["reason"].as_str().unwrap();
    assert!(
        reason.contains("dispatch valve is off"),
        "the notice must name the valve: {reason}"
    );
    let requests_after = std::fs::read_dir(&requests).unwrap().count();
    assert_eq!(
        requests_after, requests_before,
        "a deferred automatic continuation must not reach the provider"
    );
}

/// With the valve open the same setup must really spend one automatic turn.
///
/// The pair of tests guards both directions: the gate may not over-block a
/// legitimate continuation, and it must not spend one when the valve is closed.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn an_open_dispatch_valve_starts_exactly_one_automatic_turn() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    let requests = temp.path().join("recorded-requests");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&requests).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    value["goal_max_auto_continuations"] = json!(1);
    value["continuous_work"] = json!({"dispatch_enabled": true});
    value["session_memory"] = json!({"enabled": false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("goal-pro")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TUI_LAB_REQUEST_DIR", &requests)
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"work-valve-open","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true}}
        }}),
    );
    assert!(server.response(1).get("error").is_none());

    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[
            {"type":"text","text":"continuous-work-fixture-request: please complete this task"}
        ]}}),
    );
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");

    let deadline = Instant::now() + Duration::from_secs(20);
    let work_id = loop {
        server.send(json!({"id":4,"method":"work/list","params":{}}));
        let page = server.response(4);
        if let Some(work) = page["result"]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["threadId"] == thread))
        {
            break work["workId"].as_str().unwrap().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the goal input was not bound to a work record: {page}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };

    let requests_before = std::fs::read_dir(&requests).unwrap().count();
    let turn_deadline = Instant::now() + Duration::from_secs(40);
    let mut automatic_turns = 0;
    while automatic_turns == 0 {
        let frame = server.next_value(turn_deadline);
        if frame["method"] == "turn/started"
            && frame["params"]["turn"]["threadId"] == json!(thread)
            && frame["params"]["turn"]["internal"] == json!(true)
        {
            automatic_turns += 1;
        }
    }
    // The provider request is written after the turn starts, so give the real
    // request a bounded window instead of racing it.
    let provider_deadline = Instant::now() + Duration::from_secs(15);
    let mut requests_after = requests_before;
    while requests_after <= requests_before {
        assert!(
            Instant::now() < provider_deadline,
            "an admitted automatic continuation must reach the provider ({requests_before} -> {requests_after})"
        );
        std::thread::sleep(Duration::from_millis(25));
        requests_after = std::fs::read_dir(&requests).unwrap().count();
    }
    assert_eq!(
        automatic_turns, 1,
        "the open valve admits exactly one automatic turn"
    );

    // The claim the gate took is what advances the durable batch counters, and
    // the client must read them back through work/read.
    let usage_deadline = Instant::now() + Duration::from_secs(20);
    loop {
        server.send(json!({"id":9,"method":"work/read","params":{"workId":work_id.clone()}}));
        let read = server.response(9);
        let turns = read["result"]["work"]["usage"]["automaticTurns"]
            .as_u64()
            .unwrap_or(0);
        if turns >= 1 {
            break;
        }
        assert!(
            Instant::now() < usage_deadline,
            "the automatic turn must be visible in the durable counters: {read}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A bound work item must still be observable after the host restarts.
///
/// The plan lists restart recovery as unverified: this checks the durable side
/// that can be proven here - the record, its thread binding and its original
/// attempt survive a graceful shutdown and a fresh app-server on the same
/// private profile.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn a_bound_work_item_survives_a_host_restart() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    value["goal_max_auto_continuations"] = json!(0);
    value["continuous_work"] = json!({"dispatch_enabled": false});
    value["session_memory"] = json!({"enabled": false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let spin_up = |writer: &mut dyn FnMut(&mut TestAppServer)| {
        let mut builder = TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .temp_dir(temp.path())
            .scenario("goal-pro")
            .stream_delay_ms("1")
            .discard_stderr()
            .env("KCODER_TRUST_ALL", "0");
        builder.training_mode = true;
        let mut server = builder.spawn();
        writer(&mut server);
        server
    };

    let mut first =
        spin_up(&mut |server: &mut TestAppServer| {
            server.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"work-restart-a","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true}}
        }}));
            assert!(server.response(1).get("error").is_none());
        });
    first.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = first.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    first.send(
        json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[
            {"type":"text","text":"continuous-work-fixture-request: please complete this task"}
        ]}}),
    );
    assert!(first.response(3).get("error").is_none());
    first.wait_for_method("turn/completed");
    let deadline = Instant::now() + Duration::from_secs(20);
    let work_id = loop {
        first.send(json!({"id":4,"method":"work/list","params":{}}));
        let page = first.response(4);
        if let Some(work) = page["result"]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["threadId"] == thread))
        {
            break work["workId"].as_str().unwrap().to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the goal input was not bound before the restart: {page}"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    first.shutdown_successfully();

    let mut second =
        spin_up(&mut |server: &mut TestAppServer| {
            server.send(json!({"jsonrpc":"2.0","id":11,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"work-restart-b","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true}}
        }}));
            assert!(server.response(11).get("error").is_none());
        });
    second.send(json!({"id":12,"method":"work/list","params":{}}));
    let page = second.response(12);
    let listed = page["result"]["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["workId"] == json!(work_id)))
        .cloned()
        .unwrap_or_else(|| panic!("the bound work item did not survive the restart: {page}"));
    assert_eq!(listed["threadId"], json!(thread));

    second.send(json!({"id":13,"method":"work/read","params":{"workId":work_id}}));
    let read = second.response(13);
    assert_eq!(
        read["result"]["work"]["workId"],
        json!(work_id),
        "the recorded work item must stay readable after a restart: {read}"
    );
}

/// The client-visible session surface must not change across an automatic turn.
///
/// The thread view carries the session mode, the model selection and the frozen
/// settings-template binding, so this is the L2 half of CT-97: whatever the
/// continuation does internally, it may not switch the user's session.
#[test]
#[ignore = "requires an isolated native app-server and private profile"]
fn an_automatic_turn_leaves_the_thread_session_surface_unchanged() {
    let temp = super::thread_goal_status_batch::private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    value["history_enabled"] = json!(true);
    value["permission_mode"] = json!("bypass");
    value["goal_max_auto_continuations"] = json!(1);
    value["continuous_work"] = json!({"dispatch_enabled": true});
    value["session_memory"] = json!({"enabled": false});
    std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();

    let mut builder = TestAppServer::builder(&workspace, &settings)
        .config_dir(&config)
        .temp_dir(temp.path())
        .scenario("goal-pro")
        .stream_delay_ms("1")
        .discard_stderr()
        .env("KCODER_TRUST_ALL", "0");
    builder.training_mode = true;
    let mut server = builder.spawn();
    server.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"work-surface-l2","version":"1"},
            "capabilities":{"experimental":{"continuousWorkReadV1":true}}
        }}),
    );
    assert!(server.response(1).get("error").is_none());

    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[
            {"type":"text","text":"continuous-work-fixture-request: please complete this task"}
        ]}}),
    );
    assert!(server.response(3).get("error").is_none());
    server.wait_for_method("turn/completed");

    let surface = |server: &mut TestAppServer, id: i64| -> Value {
        server.send(json!({"id":id,"method":"thread/read","params":{"threadId":thread}}));
        let result = server.response(id)["result"]["thread"].clone();
        json!({
            "id": result["id"],
            "sessionMode": result["sessionMode"],
            "model": result["model"],
            "modelSelectionMode": result["modelSelectionMode"],
            "selectedModel": result["selectedModel"],
            "settingsTemplate": result["settingsTemplate"],
            "cwd": result["cwd"],
        })
    };
    let before = surface(&mut server, 10);

    // Let the admitted automatic continuation run and finish.
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let frame = server.next_value(deadline);
        if frame["method"] == "turn/completed" && frame["params"]["turn"]["internal"] == json!(true)
        {
            break;
        }
    }
    let after = surface(&mut server, 11);
    assert_eq!(
        before, after,
        "an automatic turn must not switch the thread's session surface"
    );
}
