// Actual app-server subprocess/native parent/resource/Office state acceptance.
// The HTTP model fixture selects fixed tools; it proves transport and execution,
// not model quality, paid-provider behavior or Windows installation acceptance.
#[cfg(target_os = "linux")]
mod integrations_office {
    use super::*;
    use kcoder_state::integrations::office::OfficeStore;
    use kcoder_types::integrations::{
        core::IntegrationOwner,
        office::{OfficeArtifactManifest, OfficeArtifactRef, OfficeCanonicalSourceAvailability},
    };
    use std::path::{Path, PathBuf};

    const OFFICE_ENV: &str = "KCODER_NATIVE_OFFICE_BINDING_V1";
    const PARENT_ENV: &str = "KCODER_PRIVATE_RETENTION_PARENT_V1";
    const ABSENT: &str = "office-startup-env-absent";
    const ENV_COMMAND: &str = "if [ \"${KCODER_NATIVE_OFFICE_BINDING_V1+x}\" = x ]; then printf office-startup-env-PRESENT; else printf office-startup-env-absent; fi";

    fn launch_observation() -> Value {
        let path = std::env::var_os("KCODER_OFFICE_NATIVE_NODE_LAUNCH")
            .expect("explicit actual staged Node/native-launch observation fixture");
        let bytes = std::fs::read(path).expect("read owned native-launch observation");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["runtime"]["mode"], "standalone_node");
        assert!(Path::new(value["componentRoot"].as_str().unwrap()).is_absolute());
        assert!(Path::new(value["runtime"]["program"].as_str().unwrap()).is_file());
        value
    }
    fn startup(value: &Value) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    }
    fn parent() -> String {
        format!(
            "v1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"version":1,"mode":"localOs"}"#)
        )
    }
    fn tool_result(request: &Value, id: &str) -> Option<Value> {
        request["messages"]
            .as_array()?
            .iter()
            .rev()
            .find_map(|message| {
                if message["role"] != "tool" || message["tool_call_id"] != id {
                    return None;
                }
                let text = message["content"].as_str()?;
                Some(serde_json::from_str(text).unwrap_or_else(|_| json!({"text":text})))
            })
    }
    fn assert_absent_environment(request: &Value) {
        let value = tool_result(request, "office-ordinary-env")
            .expect("ordinary tool result must reach the next real model request");
        let text = serde_json::to_string(&value).unwrap();
        assert!(
            text.contains(ABSENT),
            "ordinary descendant must not inherit reserved Office startup configuration: {text}"
        );
        assert!(!text.contains("office-startup-env-PRESENT"));
    }
    fn discovery_result(request: &Value, id: &str) -> Value {
        let value = tool_result(request, id).expect("actual tool discovery receipt");
        let text = value["text"].as_str().expect("Markdown discovery receipt");
        let json = text
            .split_once("```json\n")
            .and_then(|(_, rest)| rest.split_once("\n```"))
            .map(|(json, _)| json)
            .expect("bounded JSON discovery metadata inside the Markdown receipt");
        serde_json::from_str(json).expect("valid discovery metadata")
    }
    fn settings(path: &Path, endpoint: &str, enabled: bool) {
        write_fixture_provider_settings(path, endpoint);
        let mut value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        value["permission_mode"] = json!("bypass");
        value["session_memory"] = json!({"enabled":false});
        value["integrations"] = json!({"office":{"enabled":enabled}});
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn initialize(server: &mut TestAppServer) {
        server.send(json!({"id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"actual-native-office-stdio","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"studioWorkModesV1":true,"threadStreamContextV1":true,"officeWorkspaceV1":true}}
        }}));
        let response = server.response(1);
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(
            response["result"]["capabilities"]["experimental"]["integrationScopeV1"], true,
            "{response}"
        );
    }
    fn run_turn(server: &mut TestAppServer, workspace: &Path, mode: &str) -> (String, String) {
        initialize(server);
        server.send(json!({"id":2,"method":"thread/start","params":{"cwd":workspace,"studioWorkMode":mode}}));
        let response = server.response(2);
        assert!(response.get("error").is_none(), "{response}");
        let thread = response["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,"clientPresentation":{"version":1,"studioWorkMode":mode,"inlineWidgets":false},"input":[{"type":"text","text":"Use the supplied literal meeting material: approved amount 1234.56, responsible person not yet known. Produce the requested real DOCX; preserve unknowns."}]}}));
        let response = server.response(3);
        assert!(response.get("error").is_none(), "{response}");
        let turn = response["result"]["turn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let deadline = Instant::now() + Duration::from_secs(110);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" {
                assert_eq!(event["params"]["threadId"], thread);
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        (thread, turn)
    }
    fn profile(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        (workspace, profile, settings)
    }

    #[test]
    #[ignore = "Requires explicit real staged Office/Node observation; native stdio gate"]
    fn integration_office_stdio_verified_parent_generates_docx_and_canonical_source() {
        let launch = launch_observation();
        let root = tempfile::tempdir().unwrap();
        let (workspace, profile, config) = profile(root.path());
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            move |index, request| match index {
                0 => FixtureAnswer::Tool {
                    id: "office-ordinary-env".into(),
                    name: "bash".into(),
                    input: json!({"command":ENV_COMMAND}),
                },
                1 => {
                    assert_absent_environment(request);
                    FixtureAnswer::Tool {
                        id: "office-discovery".into(),
                        name: "tool_search".into(),
                        input: json!({"query":"OfficeDocument","limit":1}),
                    }
                }
                2 => {
                    let value = discovery_result(request, "office-discovery");
                    assert_eq!(value["tools"][0]["name"], "OfficeDocument", "{value}");
                    FixtureAnswer::Tool {
                        id: "office-create".into(),
                        name: "tool_execute".into(),
                        input: json!({"tool_name":"OfficeDocument","arguments":{"specification":{"schemaVersion":1,"kind":"docx","title":"真实普通回合 Office 交付","paragraphs":[{"text":"已批准金额1234.56；责任人待确认；不编造缺失字段。"}]},"sourceRefs":[]}}),
                    }
                }
                _ => {
                    let result = tool_result(request, "office-create").unwrap();
                    assert_eq!(result["format"], "docx", "{result}");
                    assert!(result["artifactRef"]["id"].is_string(), "{result}");
                    FixtureAnswer::Text(
                        "Native Office artifact was actually saved; reader layout remains pending."
                            .into(),
                    )
                }
            },
            Some(4),
            Duration::from_secs(60),
        );
        settings(&config, &endpoint, true);
        let mut builder = TestAppServer::builder(&workspace, &config)
            .config_dir(&profile)
            .without_scenario()
            .env(OFFICE_ENV, startup(&launch))
            .env(PARENT_ENV, parent());
        builder.training_mode = true;
        let mut server = builder.spawn();
        let (thread, turn) = run_turn(&mut server, &workspace, "kworker");
        let recorded = calls.lock().unwrap();
        assert_eq!(recorded.len(), 4);
        let projected = tool_result(&recorded[3], "office-create").unwrap();
        let reference: OfficeArtifactRef =
            serde_json::from_value(projected["artifactRef"].clone()).unwrap();
        drop(recorded);
        server.send(json!({"id":50,"method":"integrations/scope/read","params":{}}));
        let scope = server.response(50)["result"].clone();
        let exported = integration_memory_request(
            &mut server,
            51,
            "integrations/artifact/export",
            &scope,
            Some("public-office-export"),
            None,
            json!({"reference":reference,"format":"docx"}),
        );
        assert_eq!(exported["result"]["status"], "completed", "{exported}");
        let receipt: kcoder_types::integrations::office::OfficeExportReceipt =
            serde_json::from_value(exported["result"]["result"]["export"].clone()).unwrap();
        let locator = format!(
            "office-export:{}:{}",
            receipt.export_id, receipt.lease_revision
        );
        server.send(json!({"id":52,"method":"attachment/read/chunk","params":{"threadId":thread,"path":locator,"offset":0,"length":65536}}));
        let chunk = server.response(52);
        assert!(chunk.get("error").is_none(), "{chunk}");
        let received = base64::engine::general_purpose::STANDARD
            .decode(chunk["result"]["contentBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(&received[..2], b"PK");
        assert_eq!(format!("{:x}", Sha256::digest(&received)), receipt.sha256);
        server.send(json!({"id":53,"method":"attachment/read/chunk","params":{"threadId":"another-thread","path":locator,"offset":0,"length":65536}}));
        assert!(server.response(53).get("error").is_some());
        server.shutdown();
        fixture.join().unwrap();
        let state_path = find_named_file(&profile, "office-state.json")
            .expect("the ordinary turn actually created private native Office state");
        let value: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        let owner: IntegrationOwner = serde_json::from_value(value["owner"].clone()).unwrap();
        let store = OfficeStore::open_existing(state_path.parent().unwrap(), owner)
            .unwrap()
            .unwrap();
        let artifacts = store.list_artifacts(&thread).unwrap();
        assert_eq!(artifacts.len(), 1);
        let manifest: &OfficeArtifactManifest = &artifacts[0];
        assert_eq!(manifest.task.turn_id, turn);
        assert_eq!(manifest.id, reference.id);
        let (bytes, total) = store.read_artifact_chunk(&reference, 0, 65536).unwrap();
        assert_eq!(&bytes[..2], b"PK");
        assert_eq!(total, manifest.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), manifest.sha256);
        assert_eq!(projected["sha256"], manifest.sha256);
        let metadata = store
            .read_canonical_source(&reference, None, 0, 65536, true)
            .unwrap();
        assert_eq!(
            metadata.availability,
            OfficeCanonicalSourceAvailability::Available
        );
        let source = metadata.source.unwrap();
        let page = store
            .read_canonical_source(
                &reference,
                Some(&source.specification_sha256),
                0,
                65536,
                false,
            )
            .unwrap();
        assert!(page.complete);
        let text = page.chunk.unwrap();
        assert_eq!(text.len() as u64, source.specification_bytes);
        assert_eq!(
            format!("{:x}", Sha256::digest(text.as_bytes())),
            source.specification_sha256
        );
        assert_eq!(source.output_sha256, manifest.sha256);
        assert!(text.contains("1234.56") && text.contains("责任人待确认"));
        assert_eq!(source.task.turn_id, turn);
    }

    #[test]
    #[ignore = "Requires explicit real staged Office/Node observation; native stdio negative gate"]
    fn integration_office_stdio_unavailable_conditions_keep_ordinary_turns_working() {
        let original = launch_observation();
        for condition in ["missing_parent", "wrong_manifest", "disabled", "kcoder"] {
            let root = tempfile::tempdir().unwrap();
            let (workspace, profile, config) = profile(root.path());
            let expected = condition.to_owned();
            let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
                move |index, request| {
                    let names = request["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|item| item["function"]["name"].as_str())
                        .collect::<Vec<_>>();
                    assert!(
                        !names.iter().any(|name| name.starts_with("Office")),
                        "{expected}: unavailable Office must not attach native schemas"
                    );
                    match index {
                        0 => FixtureAnswer::Tool {
                            id: "office-ordinary-env".into(),
                            name: "bash".into(),
                            input: json!({"command":ENV_COMMAND}),
                        },
                        1 => {
                            assert_absent_environment(request);
                            if expected == "kcoder" {
                                FixtureAnswer::Text(
                                    "Ordinary KCoder turn remains available.".into(),
                                )
                            } else {
                                FixtureAnswer::Tool {
                                    id: "office-missing-discovery".into(),
                                    name: "tool_search".into(),
                                    input: json!({"query":"OfficeDocument","limit":1}),
                                }
                            }
                        }
                        _ => {
                            let result = discovery_result(request, "office-missing-discovery");
                            assert_eq!(result["total_matches"], 0, "{expected}: {result}");
                            FixtureAnswer::Text(
                                "Ordinary turn completed; native Office is unavailable.".into(),
                            )
                        }
                    }
                },
                Some(if condition == "kcoder" { 2 } else { 3 }),
                Duration::from_secs(30),
            );
            settings(&config, &endpoint, condition != "disabled");
            let mut launch = original.clone();
            if condition == "wrong_manifest" {
                launch["manifestSha256"] = json!("0".repeat(64));
            }
            let mut builder = TestAppServer::builder(&workspace, &config)
                .config_dir(&profile)
                .without_scenario()
                .env(OFFICE_ENV, startup(&launch));
            if condition != "missing_parent" {
                builder = builder.env(PARENT_ENV, parent());
            }
            builder.training_mode = true;
            let mut server = builder.spawn();
            run_turn(
                &mut server,
                &workspace,
                if condition == "kcoder" {
                    "kcoder"
                } else {
                    "kworker"
                },
            );
            server.shutdown();
            fixture.join().unwrap();
            assert_eq!(
                calls.lock().unwrap().len(),
                if condition == "kcoder" { 2 } else { 3 }
            );
            assert!(
                find_named_file(&profile, "office-state.json").is_none(),
                "{condition}: unavailable capability must not initialize Office state"
            );
        }
    }
    include!("integrations_office_knowledge.rs");
}
