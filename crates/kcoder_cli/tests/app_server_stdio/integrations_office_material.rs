// Actual public upload/receipt/disconnect/Native OfficeRead consumer acceptance.
// Fixed Provider tools verify protocol and bytes, not model selection quality.
#[cfg(target_os = "linux")]
mod integrations_office_material {
    use super::*;
    use kcoder_types::integrations::office::OfficeMaterialReceipt;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    const GATE: &str = "KCODER_OFFICE_NATIVE_NODE_LAUNCH";
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        let value = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27", "clientInfo":{"name":"actual-office-material-stdio","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"officeWorkspaceV1":true,"studioWorkModesV1":true,"threadStreamContextV1":true}}}),
        );
        assert!(value["error"].is_null(), "{value}");
        assert_eq!(
            value["result"]["capabilities"]["experimental"]["officeWorkspaceV1"], true,
            "{value}"
        );
        let scope = rpc(server, 2, "integrations/scope/read", json!({}));
        assert!(scope["error"].is_null(), "{scope}");
        scope["result"].clone()
    }
    fn threads(server: &mut TestAppServer, id: i64) -> usize {
        let value = rpc(server, id, "thread/list", json!({}));
        assert!(value["error"].is_null(), "{value}");
        value["result"]["threads"].as_array().unwrap().len()
    }
    fn envelope(scope: &Value, id: &str, operation: Option<&str>, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":id,"scope":scope,"operationId":operation,"timeoutMs":30000,"payload":payload})
    }
    fn upload(server: &mut TestAppServer, base: i64, bytes: &[u8]) -> String {
        let start = rpc(
            server,
            base,
            "attachment/upload/start",
            json!({"filename":"material.txt","size":bytes.len()}),
        );
        assert!(start["error"].is_null(), "{start}");
        let id = start["result"]["upload_id"].as_str().unwrap().to_owned();
        for (index, chunk) in bytes.chunks(512 * 1024).enumerate() {
            let part = rpc(
                server,
                base + 1 + index as i64,
                "attachment/upload/chunk",
                json!({"upload_id":id,"index":index,"content_base64":base64::engine::general_purpose::STANDARD.encode(chunk)}),
            );
            assert!(part["error"].is_null(), "{part}");
        }
        id
    }
    fn metadata(bytes: &[u8]) -> Value {
        json!({"filename":"material.txt","mediaType":"text/plain","expectedBytes":bytes.len(),"expectedSha256":format!("{:x}",Sha256::digest(bytes))})
    }
    fn tool_result(request: &Value, id: &str) -> Value {
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find_map(|message| {
                (message["role"] == "tool" && message["tool_call_id"] == id).then(|| {
                    let text = message["content"].as_str().unwrap();
                    serde_json::from_str(text).unwrap_or_else(|_| json!({"text":text}))
                })
            })
            .unwrap_or_else(|| panic!("Native result for {id} absent"))
    }
    fn builder(
        workspace: &Path,
        settings: &Path,
        profile: &Path,
        startup: &str,
    ) -> TestAppServerBuilder {
        let parent = format!(
            "v1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"version":1,"mode":"localOs"}"#)
        );
        let mut builder = TestAppServer::builder(workspace, settings)
            .config_dir(profile)
            .without_scenario()
            .env("KCODER_NATIVE_OFFICE_BINDING_V1", startup)
            .env("KCODER_PRIVATE_RETENTION_PARENT_V1", parent);
        builder.training_mode = true;
        builder
    }

    #[test]
    #[ignore = "Requires explicit sealed Office/Node observation; actual public upload and owned Native reader gate"]
    fn integration_office_public_material_upload_survives_disconnect_and_native_read() {
        let launch = std::fs::read(
            std::env::var_os(GATE).expect("explicit actual sealed resource observation"),
        )
        .unwrap();
        let observation: Value = serde_json::from_slice(&launch).unwrap();
        assert_eq!(observation["runtime"]["mode"], "standalone_node");
        let startup = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&observation).unwrap());
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let settings = profile.join("settings.json");
        let accepted: Arc<Mutex<Option<OfficeMaterialReceipt>>> = Arc::new(Mutex::new(None));
        let model_accepted = accepted.clone();
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            move |index, request| match index {
                0 => FixtureAnswer::Tool {
                    id: "material-discovery".into(),
                    name: "tool_search".into(),
                    input: json!({"query":"OfficeRead","limit":1}),
                },
                1 => {
                    let receipt = tool_result(request, "material-discovery");
                    let text = receipt["text"].as_str().unwrap();
                    let json = text
                        .split("```json")
                        .nth(1)
                        .unwrap()
                        .split("```")
                        .next()
                        .unwrap();
                    let discovery: Value = serde_json::from_str(json.trim()).unwrap();
                    assert_eq!(discovery["tools"][0]["name"], "OfficeRead");
                    let material = model_accepted.lock().unwrap().clone().unwrap();
                    FixtureAnswer::Tool {
                        id: "read-durable-material".into(),
                        name: "tool_execute".into(),
                        input: json!({"tool_name":"OfficeRead","arguments":{"reference":{"id":material.input_id,"revision":1},"limit":1}}),
                    }
                }
                _ => {
                    let value = tool_result(request, "read-durable-material");
                    let material = model_accepted.lock().unwrap().clone().unwrap();
                    assert_eq!(value["sha256"], material.sha256, "{value}");
                    assert!(
                        value["chunks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|chunk| chunk["text"]
                                .as_str()
                                .is_some_and(|text| text.contains("NATIVE_MATERIAL_1234.56"))),
                        "{value}"
                    );
                    FixtureAnswer::Text(
                        "Actual original material was read; business review remains separate."
                            .into(),
                    )
                }
            },
            Some(3),
            Duration::from_secs(90),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        config["permission_mode"] = json!("bypass");
        config["session_memory"] = json!({"enabled":false});
        config["integrations"] = json!({"office":{"enabled":true}});
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        let mut first = builder(&workspace, &settings, &profile, &startup).spawn();
        let scope = initialize(&mut first);
        assert_eq!(threads(&mut first, 3), 0);
        // Native limit rejects before allocation/namespace publication.
        let oversized = rpc(
            &mut first,
            4,
            "attachment/upload/start",
            json!({"filename":"material.txt","size":104857601u64}),
        );
        assert!(oversized["error"].is_object(), "{oversized}");
        let cancelled = upload(&mut first, 10, b"partial owned bytes");
        assert!(
            rpc(
                &mut first,
                15,
                "attachment/upload/cancel",
                json!({"upload_id":cancelled})
            )["error"]
                .is_null()
        );
        let after_cancel = rpc(
            &mut first,
            16,
            "attachment/upload/finish",
            json!({"upload_id":cancelled,"office_input":envelope(&scope,"cancel-finish",Some("cancelled-material"),metadata(b"partial owned bytes"))}),
        );
        assert!(after_cancel["error"].is_object());
        assert!(after_cancel["result"].is_null());
        let forged = upload(&mut first, 20, b"owned but invalid metadata");
        let mut bad = metadata(b"owned but invalid metadata");
        bad["path"] = json!("not-a-native-file-grant");
        let rejected = rpc(
            &mut first,
            25,
            "attachment/upload/finish",
            json!({"upload_id":forged,"office_input":envelope(&scope,"bad-metadata",Some("bad-material"),bad)}),
        );
        assert!(rejected["error"].is_object());
        assert!(rejected["result"].is_null());
        assert_eq!(threads(&mut first, 26), 0);
        assert!(calls.lock().unwrap().is_empty());
        let bytes = "NATIVE_MATERIAL_1234.56\n".repeat(50001).into_bytes();
        assert!(bytes.len() > 1024 * 1024);
        let upload_id = upload(&mut first, 100, &bytes);
        let request = envelope(
            &scope,
            "actual-material-finish",
            Some("actual-material-operation"),
            metadata(&bytes),
        );
        let finished = rpc(
            &mut first,
            110,
            "attachment/upload/finish",
            json!({"upload_id":upload_id,"office_input":request}),
        );
        assert!(finished["error"].is_null(), "{finished}");
        let material: OfficeMaterialReceipt =
            serde_json::from_value(finished["result"].clone()).unwrap();
        material.validate().unwrap();
        assert_eq!(material.bytes, bytes.len() as u64);
        assert_eq!(material.sha256, format!("{:x}", Sha256::digest(&bytes)));
        assert!(
            finished["result"].get("path").is_none() && finished["result"].get("native").is_none()
        );
        // Lost/delayed ACK cannot turn an already-consumed native upload ID into
        // a second file write. Public original-operation readback is authority.
        let repeated = rpc(
            &mut first,
            111,
            "attachment/upload/finish",
            json!({"upload_id":upload_id,"office_input":request}),
        );
        assert!(repeated["error"].is_object());
        assert!(repeated["result"].is_null());
        let original = rpc(
            &mut first,
            112,
            "integrations/office/readOperation",
            envelope(
                &scope,
                "read-original-material",
                None,
                json!({"operationId":"actual-material-operation"}),
            ),
        );
        assert_eq!(original["result"]["status"], "completed", "{original}");
        assert_eq!(
            original["result"]["result"]["result"]["inputId"],
            material.input_id
        );
        assert_eq!(
            original["result"]["result"]["result"]["sha256"],
            material.sha256
        );
        assert_eq!(threads(&mut first, 113), 0);
        assert!(calls.lock().unwrap().is_empty());
        *accepted.lock().unwrap() = Some(material);
        first.shutdown_successfully();
        let mut restored = builder(&workspace, &settings, &profile, &startup).spawn();
        initialize(&mut restored);
        assert_eq!(threads(&mut restored, 3), 0);
        let started = rpc(
            &mut restored,
            4,
            "thread/start",
            json!({"cwd":workspace,"studioWorkMode":"kworker"}),
        );
        assert!(started["error"].is_null(), "{started}");
        let thread = started["result"]["thread"]["id"].as_str().unwrap();
        let run = rpc(
            &mut restored,
            5,
            "turn/start",
            json!({"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":false},"input":[{"type":"text","text":"Read the selected real stored material using OfficeRead; preserve unknown facts."}]}),
        );
        assert!(run["error"].is_null(), "{run}");
        let turn = run["result"]["turn"]["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(100);
        loop {
            let event = restored.next_value(deadline);
            if event["method"] == "turn/completed"
                && event["params"]["threadId"] == thread
                && event["params"]["turnId"] == turn
            {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 3);
        restored.shutdown_successfully();
        fixture.join().unwrap();
    }

    fn initialize_receipt_owner(server: &mut TestAppServer) -> Value {
        let reply = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"ordinary-material-ack-cold","version":"1"},"capabilities":{"experimental":{
                "integrationScopeV1":true,"officeWorkspaceV1":true,"officeExportReceiptV1":true,
                "studioWorkModesV1":true,"threadStreamContextV1":true}}}),
        );
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["officeExportReceiptV1"], true,
            "{reply}"
        );
        let scope = rpc(server, 2, "integrations/scope/read", json!({}));
        assert!(scope.get("error").is_none(), "{scope}");
        scope["result"].clone()
    }
    fn assert_actual_discovery(request: &Value, call: &str, name: &str) {
        let receipt = tool_result(request, call);
        let text = receipt["text"]
            .as_str()
            .expect("actual Markdown ToolSearch receipt");
        let parsed: Value = serde_json::from_str(
            text.split_once("```json")
                .expect("ToolSearch JSON fence")
                .1
                .split_once("```")
                .expect("complete ToolSearch JSON fence")
                .0
                .trim(),
        )
        .unwrap();
        let names = parsed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        eprintln!(
            "TWD12_TOOL_DISCOVERY {}",
            json!({"expectedTool":name,"names":names,
            "totalMatches":parsed["total_matches"],"emptyReason":parsed["empty_reason"],
            "receiptSha256":format!("{:x}",Sha256::digest(text.as_bytes()))})
        );
        assert!(
            parsed["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name && tool["call_via"] == "tool_execute"),
            "actual permitted definition missing"
        );
    }
    fn ordinary_ack_evidence(name: &str, value: &Value) {
        eprintln!("TWD12_ORDINARY_CHAIN {name} {value}");
        if let Some(directory) = std::env::var_os("KCODER_OFFICE_ACK_EVIDENCE_DIR") {
            let path = std::path::PathBuf::from(directory);
            assert!(path.is_absolute());
            let directory = kcoder_config::PrivateDirectory::open_or_create(&path).unwrap();
            directory.verify_private_directory().unwrap();
            directory
                .atomic_replace(
                    std::ffi::OsStr::new(name),
                    &serde_json::to_vec_pretty(value).unwrap(),
                )
                .unwrap();
        }
    }

    #[test]
    #[ignore = "Requires sealed actual Office/Node; ordinary material/read/document/native ACK and cold normal process,0paid"]
    fn integration_office_original_material_generation_ack_and_cold_reopen_form_one_chain() {
        use kcoder_types::integrations::office::{
            OfficeArtifactManifest, OfficeArtifactRef, OfficeCanonicalSourceDescriptor,
            OfficeExportAcknowledgementReceipt, OfficeExportReceipt,
        };
        const TEXT: &str =
            "TWD12_ORDINARY_MATERIAL: approved amount 1234.56; responsible person remains unknown.";
        let observation: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var_os(GATE).expect("explicit actual sealed Office observation"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(observation["runtime"]["mode"], "standalone_node");
        let startup = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&observation).unwrap());
        let root = tempfile::tempdir().unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
        directory
            .create_private_child(std::ffi::OsStr::new("workspace"))
            .unwrap();
        directory
            .create_private_child(std::ffi::OsStr::new("profile"))
            .unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        let settings = profile.join("settings.json");
        let selected: Arc<Mutex<Option<OfficeMaterialReceipt>>> = Arc::new(Mutex::new(None));
        let generated: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let selected_for_model = selected.clone();
        let generated_for_model = generated.clone();
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            move |index, request| {
                let material = selected_for_model
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("actual material receipt");
                match index {
                    0 => {
                        let original = serde_json::to_string(request).unwrap();
                        assert!(
                            original.contains(material.input_id.as_str())
                                && original.contains(material.sha256.as_str()),
                            "original public input must select its own real material"
                        );
                        FixtureAnswer::Tool {
                            id: "ordinary-discover-read".into(),
                            name: "tool_search".into(),
                            input: json!({"query":"OfficeRead","limit":1}),
                        }
                    }
                    1 => {
                        assert_actual_discovery(request, "ordinary-discover-read", "OfficeRead");
                        FixtureAnswer::Tool {
                            id: "ordinary-read-material".into(),
                            name: "tool_execute".into(),
                            input: json!({"tool_name":"OfficeRead","arguments":{"reference":{"id":material.input_id,"revision":material.revision},"limit":1}}),
                        }
                    }
                    2 => {
                        let read = tool_result(request, "ordinary-read-material");
                        assert_eq!(read["sha256"], material.sha256, "{read}");
                        assert!(
                            read["chunks"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|chunk| chunk["text"]
                                    .as_str()
                                    .is_some_and(|text| text.contains(TEXT))),
                            "actual OfficeRead must return the original material before generation"
                        );
                        FixtureAnswer::Tool {
                            id: "ordinary-discover-document".into(),
                            name: "tool_search".into(),
                            input: json!({"query":"OfficeDocument","limit":1}),
                        }
                    }
                    3 => {
                        assert_actual_discovery(
                            request,
                            "ordinary-discover-document",
                            "OfficeDocument",
                        );
                        FixtureAnswer::Tool {
                            id: "ordinary-generate-document".into(),
                            name: "tool_execute".into(),
                            input: json!({"tool_name":"OfficeDocument","arguments":{
                        "specification":{"schemaVersion":1,"kind":"docx","title":"Ordinary original material deliverable",
                            "sourceRefs":[format!("{}@{}",material.input_id,material.revision)],"paragraphs":[{"text":TEXT}]},
                        "sourceRefs":[{"kind":"input","id":material.input_id,"revision":material.revision.to_string()}]}}),
                        }
                    }
                    4 => {
                        let artifact = tool_result(request, "ordinary-generate-document");
                        assert!(
                            artifact["artifactRef"]["id"].is_string()
                                && artifact["format"] == "docx",
                            "{artifact}"
                        );
                        *generated_for_model.lock().unwrap() = Some(artifact);
                        FixtureAnswer::Text("Original literal material generated one native DOCX; semantic review remains separate.".into())
                    }
                    _ => panic!("metadata/ACK/cold must not cause another model request"),
                }
            },
            Some(5),
            Duration::from_secs(100),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut config: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        config["permission_mode"] = json!("ask");
        config["allowed_tools"] = json!([
            "OfficeRead",
            "OfficeDocument",
            "tool_search",
            "tool_execute"
        ]);
        config["session_memory"] = json!({"enabled":false});
        config["integrations"] = json!({"office":{"enabled":true}});
        std::fs::write(&settings, serde_json::to_vec(&config).unwrap()).unwrap();
        let mut first = builder(&workspace, &settings, &profile, &startup).spawn();
        let first_pid = first.child.id();
        let scope = initialize_receipt_owner(&mut first);
        let upload_id = upload(&mut first, 10, TEXT.as_bytes());
        let uploaded = rpc(
            &mut first,
            20,
            "attachment/upload/finish",
            json!({"upload_id":upload_id,"office_input":
            envelope(&scope,"ordinary-material-finish",Some("ordinary-material-accept"),metadata(TEXT.as_bytes()))}),
        );
        assert!(uploaded.get("error").is_none(), "{uploaded}");
        let material: OfficeMaterialReceipt =
            serde_json::from_value(uploaded["result"].clone()).unwrap();
        material.validate().unwrap();
        assert_eq!(
            material.sha256,
            format!("{:x}", Sha256::digest(TEXT.as_bytes()))
        );
        *selected.lock().unwrap() = Some(material.clone());
        let started = rpc(
            &mut first,
            30,
            "thread/start",
            json!({"cwd":workspace,"studioWorkMode":"kworker"}),
        );
        assert!(started.get("error").is_none(), "{started}");
        let thread = started["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let turn = rpc(
            &mut first,
            31,
            "turn/start",
            json!({"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":false},
            "input":[{"type":"text","text":format!("Read the actual selected material {}@{} SHA {}, then produce exactly one bounded DOCX preserving the amount and unknown responsibility.",material.input_id,material.revision,material.sha256)}]}),
        );
        assert!(turn.get("error").is_none(), "{turn}");
        let turn_id = turn["result"]["turn"]["id"].as_str().unwrap().to_string();
        let deadline = Instant::now() + Duration::from_secs(110);
        loop {
            let event = first.next_value(deadline);
            if event["method"] == "turn/completed" {
                assert_eq!(event["params"]["threadId"], thread);
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 5);
        let produced = generated
            .lock()
            .unwrap()
            .clone()
            .expect("actual generated result");
        let reference: OfficeArtifactRef =
            serde_json::from_value(produced["artifactRef"].clone()).unwrap();
        let read = rpc(
            &mut first,
            40,
            "integrations/artifact/read",
            envelope(
                &scope,
                "ordinary-read-manifest",
                None,
                json!({"reference":reference}),
            ),
        );
        assert_eq!(read["result"]["status"], "completed", "{read}");
        let manifest: OfficeArtifactManifest =
            serde_json::from_value(read["result"]["result"]["manifest"].clone()).unwrap();
        assert_eq!(manifest.task.thread_id, thread);
        assert_eq!(manifest.task.turn_id, turn_id);
        assert_eq!(
            manifest.source_refs,
            vec![kcoder_types::integrations::office::OfficeResourceRef {
                kind: "input".into(),
                id: material.input_id.clone(),
                revision: "1".into()
            }]
        );
        let source = rpc(
            &mut first,
            41,
            "integrations/artifact/source",
            envelope(
                &scope,
                "ordinary-source",
                None,
                json!({"reference":reference}),
            ),
        );
        assert_eq!(source["result"]["status"], "completed", "{source}");
        let canonical: OfficeCanonicalSourceDescriptor =
            serde_json::from_value(source["result"]["result"]["source"].clone()).unwrap();
        assert_eq!(canonical.output_sha256, manifest.sha256);
        assert_eq!(canonical.task, manifest.task);
        assert_eq!(canonical.inputs.len(), 1);
        assert_eq!(canonical.inputs[0].sha256, material.sha256);
        let exported = rpc(
            &mut first,
            42,
            "integrations/artifact/export",
            envelope(
                &scope,
                "ordinary-export",
                Some("ordinary-original-export"),
                json!({"reference":reference,"format":"docx"}),
            ),
        );
        assert_eq!(exported["result"]["status"], "completed", "{exported}");
        let export: OfficeExportReceipt =
            serde_json::from_value(exported["result"]["result"]["export"].clone()).unwrap();
        let locator = format!(
            "office-export:{}:{}",
            export.export_id, export.lease_revision
        );
        let mut received = Vec::new();
        let mut id = 50;
        loop {
            let chunk = rpc(
                &mut first,
                id,
                "attachment/read/chunk",
                json!({"threadId":thread,"path":locator,"offset":received.len(),"length":32768}),
            );
            id += 1;
            assert!(chunk.get("error").is_none(), "{chunk}");
            received.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk["result"]["contentBase64"].as_str().unwrap())
                    .unwrap(),
            );
            if chunk["result"]["eof"] == true {
                break;
            }
        }
        assert_eq!(received.len() as u64, manifest.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(&received)), manifest.sha256);
        let ack_payload = json!({"exportId":export.export_id,"leaseRevision":export.lease_revision,"reference":reference,"bytes":received.len(),"sha256":manifest.sha256});
        first.send(json!({"id":200,"method":"integrations/artifact/acknowledgeExport","params":envelope(&scope,"ordinary-ack-lost-reply",Some("ordinary-original-ack"),ack_payload)}));
        // receive_response(201+) discards the original ACK response. Reconcile
        // only the stable original operation, never resend ACK or save again.
        let wait = Instant::now() + Duration::from_secs(10);
        let mut next = 201;
        let ack = loop {
            let current = rpc(
                &mut first,
                next,
                "integrations/office/readOperation",
                envelope(
                    &scope,
                    "ordinary-ack-reconcile",
                    None,
                    json!({"operationId":"ordinary-original-ack"}),
                ),
            );
            next += 1;
            if current["result"]["status"] == "completed" {
                break current;
            }
            assert!(
                Instant::now() < wait,
                "original ACK did not become readable: {current}"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let receipt: OfficeExportAcknowledgementReceipt =
            serde_json::from_value(ack["result"]["result"]["result"].clone()).unwrap();
        receipt.validate_for(&manifest).unwrap();
        assert_eq!(receipt.operation_id, "ordinary-original-ack");
        assert_eq!(receipt.source_identities, canonical.inputs);
        ordinary_ack_evidence(
            "warm-original-byte-ack.json",
            &json!({"material":material,"task":manifest.task,"manifest":manifest,
            "canonical":canonical,"export":export,"acknowledgement":receipt,"modelCalls":5,"lostAckReadOriginalOperation":true,
            "diskSaveClaimed":false,"readerForThisFile":"not_performed"}),
        );
        if let Some(path) = std::env::var_os("KCODER_OFFICE_ACK_EVIDENCE_DIR") {
            kcoder_config::PrivateDirectory::open_existing(Path::new(&path))
                .unwrap()
                .atomic_replace(
                    std::ffi::OsStr::new("actual-original-received.docx"),
                    &received,
                )
                .unwrap();
        }
        first.shutdown_successfully();
        let mut cold = builder(&workspace, &settings, &profile, &startup).spawn();
        let cold_pid = cold.child.id();
        assert_ne!(
            first_pid, cold_pid,
            "cold reader must be a real new native process"
        );
        let cold_scope = initialize_receipt_owner(&mut cold);
        assert_eq!(scope, cold_scope, "same original native owner/source");
        let resumed = rpc(&mut cold, 30, "thread/resume", json!({"threadId":thread}));
        assert!(resumed.get("error").is_none(), "{resumed}");
        assert_eq!(resumed["result"]["thread"]["id"], thread);
        let read = rpc(
            &mut cold,
            31,
            "integrations/artifact/read",
            envelope(
                &cold_scope,
                "cold-original-artifact",
                None,
                json!({"reference":reference}),
            ),
        );
        assert_eq!(read["result"]["status"], "completed", "{read}");
        assert_eq!(
            serde_json::from_value::<OfficeArtifactManifest>(
                read["result"]["result"]["manifest"].clone()
            )
            .unwrap(),
            manifest
        );
        let source = rpc(
            &mut cold,
            32,
            "integrations/artifact/source",
            envelope(
                &cold_scope,
                "cold-original-source",
                None,
                json!({"reference":reference}),
            ),
        );
        assert_eq!(source["result"]["status"], "completed", "{source}");
        assert_eq!(
            serde_json::from_value::<OfficeCanonicalSourceDescriptor>(
                source["result"]["result"]["source"].clone()
            )
            .unwrap(),
            canonical
        );
        for id in [33, 34] {
            let read = rpc(
                &mut cold,
                id,
                "integrations/office/readOperation",
                envelope(
                    &cold_scope,
                    "cold-original-ack",
                    None,
                    json!({"operationId":"ordinary-original-ack"}),
                ),
            );
            assert_eq!(read["result"]["status"], "completed", "{read}");
            assert_eq!(
                serde_json::from_value::<OfficeExportAcknowledgementReceipt>(
                    read["result"]["result"]["result"].clone()
                )
                .unwrap(),
                receipt
            );
        }
        let old_lease = rpc(
            &mut cold,
            35,
            "attachment/read/chunk",
            json!({"threadId":thread,"path":locator,"offset":0,"length":1}),
        );
        assert!(
            old_lease.get("error").is_some(),
            "reopening cannot restore the original export lease"
        );
        assert_eq!(
            calls.lock().unwrap().len(),
            5,
            "cold observation must not regenerate or call a model"
        );
        cold.shutdown_successfully();
        fixture.join().unwrap();
        ordinary_ack_evidence(
            "cold-original-byte-ack-complete.json",
            &json!({"material":material,"manifest":manifest,
            "canonical":canonical,"export":export,"acknowledgement":receipt,"firstPid":first_pid,"coldPid":cold_pid,
            "newProcessStateAndSessionLease":true,"sameThread":thread,"sameTaskArtifactSourceAck":true,
            "originalAckReadTwiceExact":true,"oldExportLeaseRejected":true,"modelCallsBeforeAfter":[5,5],"paidCalls":0,
            "diskSaveClaimed":false,"viewedClaimed":false,"readerForThisFile":"not_performed"}),
        );
    }
}
