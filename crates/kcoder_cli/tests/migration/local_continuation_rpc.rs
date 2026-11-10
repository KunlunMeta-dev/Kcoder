//! Actual continuation RPC publication with explicit owned synthetic local supplements.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_migration::{
    history_branches::HistoryBranchStore, history_continuation_jobs::ContinuationJobs,
    local_attachment::HistoryLocalAttachments,
};
use kcoder_state::{
    external_history::local_attachment::SelectedLocalFile,
    historical_contexts::HistoricalContextStore,
};
use kcoder_types::{
    ContentBlock, Message, MessageOrigin,
    historical_attachment::HistoricalAttachmentSelection,
    historical_context::{HistoricalContextAttachmentProvenance, HistoricalLocalAttachmentBinding},
};
use std::path::Path;

fn start(fixture: &Fixture) -> TestAppServer {
    let mut builder = TestAppServer::builder(&fixture.workspace, &fixture.overlay)
        .config_dir(&fixture.profile)
        .discard_stderr();
    for (name, path) in [
        ("HOME", fixture.root.path()),
        ("USERPROFILE", fixture.root.path()),
        ("CLAUDE_CONFIG_DIR", fixture.claude.as_path()),
        ("CODEX_HOME", fixture.codex.as_path()),
    ] {
        builder
            .extra_env
            .push((name.into(), path.as_os_str().into()));
    }
    builder.extra_env.push((
        "KCODER_TUI_LAB_REQUEST_DIR".into(),
        fixture.workspace.join("model-requests").into_os_string(),
    ));
    let mut server = builder.spawn();
    rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"local-continuation-fixture","version":"test"}}),
    );
    server
}
fn create_params(
    key: &str,
    job: &str,
    view: &Value,
    bindings: &[HistoricalLocalAttachmentBinding],
) -> Value {
    json!({"requestId":key,"sourceJobId":job,"viewId":view,"policy":{"maxContextBytes":4194304,"maxEntries":2048,"maxAttachments":256,"maxAttachmentBytes":536870912},"options":{"model":null,"settingsTemplate":null,"studioWorkMode":"kworker","localAttachments":bindings}})
}

#[test]
fn local_supplements_publish_one_idle_runtime_with_exact_provenance_and_no_model_or_source_execution()
 {
    for tool in [false, true] {
        let (fixture, file) = super::branches::continuation::setup();
        let mut settings: Value =
            serde_json::from_slice(&fs::read(&fixture.overlay).unwrap()).unwrap();
        settings["model_capabilities"] = json!({"vision":true});
        fs::write(&fixture.overlay, serde_json::to_vec(&settings).unwrap()).unwrap();
        let image = json!({"type":"image","path":"/NEVER_GRANTED/original.png","filename":"MUST_NOT_TRUST.exe","media_type":"text/plain"});
        let document = json!({"type":"document","path":"/NEVER_GRANTED/original.pdf","title":"MUST_NOT_TRUST.pdf","media_type":"application/pdf"});
        let mut rows = fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        if tool {
            rows[1]["message"]["content"][0]["content"] = json!([{"type":"text","text":"before"},image,document,{"type":"text","text":"after"}]);
        } else {
            let session = file.file_stem().unwrap().to_str().unwrap();
            rows.push(json!({"type":"user","uuid":"local-reference","parentUuid":"old-result","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[image,document]}}));
        }
        fs::write(
            &file,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let mut server = start(&fixture);
        let (job, view) = super::branches::continuation::selected(&mut server);
        let position = if tool { 1 } else { 2 };
        if tool {
            HistoryBranchStore::open(&fixture.profile)
                .unwrap()
                .tool_attachments(&job, view.as_str().unwrap(), position, 0)
                .unwrap()
                .build(|_, _| true)
                .unwrap();
        }
        let chosen = fixture.profile.join("explicit-local-choice");
        kcoder_config::PrivateDirectory::open_or_create(&chosen).unwrap();
        let payloads = [
            crate::png_image_fixture(),
            "explicit supplied document 中文😀".as_bytes().to_vec(),
        ];
        let local = HistoryLocalAttachments::open(&fixture.profile).unwrap();
        let mut bindings = Vec::new();
        for (index, bytes) in payloads.iter().enumerate() {
            let selection = HistoricalAttachmentSelection {
                job_id: job.clone(),
                view_id: Some(view.as_str().unwrap().into()),
                position,
                block_index: if tool { 0 } else { index as u32 },
                tool_item_index: tool.then_some(index as u32),
            };
            let leaf = format!("selected-{index}.bin");
            fs::write(chosen.join(&leaf), bytes).unwrap();
            let selected =
                SelectedLocalFile::select(&chosen, Path::new(&leaf), true, |_| true).unwrap();
            let request =
                HistoryLocalAttachments::prepare_selection(&fixture.profile, &selection, |_| true)
                    .unwrap();
            let operation = uuid::Uuid::new_v4().to_string();
            let authorized = local.authorize(&operation, &request, &selected).unwrap();
            let ready = local
                .run(&operation, authorized.state.sequence, |_| true)
                .unwrap();
            assert!(!ready.historical_content_verified);
            bindings.push(HistoricalLocalAttachmentBinding {
                operation_id: operation,
                selection,
                receipt: ready.state.receipt.unwrap(),
            });
        }
        let key = uuid::Uuid::new_v4().to_string();
        let params = create_params(&key, &job, &view, &bindings);
        server.send(json!({"jsonrpc":"2.0","id":100,"method":"migration/history/continuation/create","params":params}));
        let journal = fixture
            .profile
            .join("migrations/history-continuations")
            .join(format!("{key}.json"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !journal.exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        // No create acknowledgement was consumed. Recover the same canonical options after restart.
        drop(server);
        fs::remove_file(&file).unwrap();
        fs::remove_dir_all(chosen).unwrap();
        let mut server = start(&fixture);
        let accepted = rpc(
            &mut server,
            101,
            "migration/history/continuation/create",
            params.clone(),
        );
        assert_eq!(
            accepted["job"]["options"]["localAttachments"],
            serde_json::to_value(&bindings).unwrap()
        );
        let mut changed = params.clone();
        changed["options"]["localAttachments"][0]["receipt"]["sha256"] = json!("a".repeat(64));
        server.send(json!({"jsonrpc":"2.0","id":102,"method":"migration/history/continuation/create","params":changed}));
        assert!(server.response(102).get("error").is_some());
        rpc(
            &mut server,
            103,
            "migration/history/continuation/run",
            json!({"jobId":key,"expectedSequence":0}),
        );
        let imported = super::branches::continuation::wait_continuation(&mut server, &key);
        assert_eq!(imported["job"]["projection"]["images"], 1);
        assert_eq!(imported["job"]["projection"]["files"], 1);
        let store = ContinuationJobs::open_existing(&fixture.profile, &fixture.workspace)
            .unwrap()
            .unwrap();
        let target = store.target(&key).unwrap().unwrap();
        let history = target
            .history_directory
            .join(format!("{}.jsonl", target.session_id));
        let state = kcoder_state::AppState::new(&fixture.workspace);
        state.resume_from_history(&history).unwrap();
        let messages = state.messages();
        assert_eq!(messages.len(), 1);
        let Message::User {
            origin: MessageOrigin::Runtime,
            content,
        } = &messages[0]
        else {
            panic!("only an inert Runtime seed may be published")
        };
        assert!(!kcoder_types::is_real_user_message(&messages[0]));
        assert!(kcoder_types::public_conversation_message(&messages[0]).is_none());
        assert!(state.goal().is_none());
        let descriptors = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|value| value.get("historical_attachment").cloned()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(descriptors.len(), 2);
        for (index, descriptor) in descriptors.iter().enumerate() {
            assert_eq!(descriptor["historicalContentVerified"], false);
            assert_eq!(descriptor["provenance"]["kind"], "user_supplied_local");
            assert_eq!(
                descriptor["provenance"]["operationId"],
                bindings[index].operation_id
            );
            assert_eq!(descriptor["sha256"], bindings[index].receipt.sha256);
            assert_eq!(
                fs::read(descriptor["path"].as_str().unwrap()).unwrap(),
                payloads[index]
            );
        }
        assert_eq!(descriptors[0]["mimeType"], "image/png");
        assert_eq!(descriptors[1]["mimeType"], "text/plain");
        let images = content
            .iter()
            .filter_map(|block| {
                if let ContentBlock::Image { source } = block {
                    Some(source)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(images.len(), 1);
        assert_eq!(STANDARD.decode(&images[0].data).unwrap(), payloads[0]);
        let prepared = HistoricalContextStore::open_existing(&fixture.profile)
            .unwrap()
            .unwrap()
            .reader(&key, |_| true)
            .unwrap();
        assert_eq!(prepared.context().document.attachments.len(), 2);
        assert!(
            prepared
                .context()
                .document
                .attachments
                .iter()
                .all(|value| matches!(
                    value.provenance,
                    Some(HistoricalContextAttachmentProvenance::UserSuppliedLocal { .. })
                ))
        );
        let before = fs::read(&history).unwrap();
        assert_eq!(
            rpc(
                &mut server,
                104,
                "migration/history/continuation/create",
                params
            )["job"],
            imported["job"]
        );
        assert_eq!(fs::read(&history).unwrap(), before);
        assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
        let requests = fixture.workspace.join("model-requests");
        assert!(!requests.exists() || fs::read_dir(requests).unwrap().next().is_none());
    }
}
