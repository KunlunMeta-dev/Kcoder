// Included inside integrations_office to reuse its actual native startup,
// parent observation and Markdown discovery helpers without another runtime.
// The HTTP fixture chooses tools; this proves native data/transport/permissions,
// not live model quality, Office reader layout or platform delivery.
mod fixed_knowledge_material {
    use super::*;
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    use std::sync::mpsc;

    const PUBLICATION: &str = "stdio-owned-material-publication";
    const DISCOVERY: &str = "material-office-discovery";
    const DOCUMENT: &str = "material-office-document";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MaterialCase {
        Adopted,
        MissingAdoption,
        RevokedAfterAcceptedDiscovery,
    }

    fn initialize_material_controls(server: &mut TestAppServer) -> Value {
        server.send(json!({"id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"native-office-material-stdio","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"knowledgePublicationsV1":true,
                "studioWorkModesV1":true,"threadStreamContextV1":true}}
        }}));
        let response = server.response(1);
        assert!(response.get("error").is_none(), "{response}");
        for capability in [
            "integrationScopeV1",
            "knowledgePublicationsV1",
            "studioWorkModesV1",
        ] {
            assert_eq!(
                response["result"]["capabilities"]["experimental"][capability], true,
                "{response}"
            );
        }
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        let response = server.response(2);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    fn seed_fixed_wiki(profile: &Path) -> (Value, String) {
        kcoder_config::PrivateDirectory::open_existing(profile)
            .unwrap()
            .create_private_child(std::ffi::OsStr::new("knowledge"))
            .unwrap();
        let scope = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
            &format!("profile:{}", profile.canonicalize().unwrap().display()),
            "execution-host",
        )
        .unwrap();
        let mut store =
            kcoder_knowledge::KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))
                .unwrap();
        let library = store
            .create(&scope, "material-library", "Owned actual Wiki material", "")
            .unwrap();
        let text = format!(
            "Approved amount: 1234.56. Responsible person: unknown.\n{}\nFIXED_R1_TAIL_BEYOND_PREVIEW",
            "Actual immutable source line retained in full. ".repeat(140)
        );
        let source = store
            .import_text(
                &scope,
                &library.id,
                "material-source-r1",
                "Evidence.md",
                &text,
            )
            .unwrap();
        let pages = store
            .commit_generated_pages(
                &scope,
                &library.id,
                "material-page-r1",
                vec![KnowledgePageDraft {
                    page_id: uuid::Uuid::new_v4().to_string(),
                    expected_revision: None,
                    kind: KnowledgePageKind::Concept,
                    title: "Fixed source r1".into(),
                    markdown: text.clone(),
                    citations: vec![KnowledgeCitation {
                        source_id: source.source_id,
                        revision_id: source.revision_id,
                        chunk_id: "chunk-1".into(),
                        quote: "Approved amount: 1234.56.".into(),
                    }],
                    related_page_ids: vec![],
                }],
            )
            .unwrap();
        (
            json!({"libraryId":library.id,"pageId":pages[0].page_id,"pageRevision":pages[0].revision_id}),
            text,
        )
    }

    fn publish_material(
        server: &mut TestAppServer,
        scope: &Value,
        fixed: &Value,
        adopt: bool,
    ) -> Value {
        let draft = json!({"publicationId":PUBLICATION,"title":"Fixed native material for actual OfficeDocument",
            "purpose":"Explicit model-independent source binding acceptance","visibility":"personal","audienceId":null,
            "sources":[fixed],"validFromMs":null,"validUntilMs":null,"unresolved":[]});
        let response = integration_memory_request(
            server,
            10,
            "integrations/knowledge/publishKnowledge",
            scope,
            Some("publish-material-r1"),
            Some(0),
            json!({"draft":draft}),
        );
        assert_eq!(response["result"]["status"], "completed", "{response}");
        let publication = response["result"]["result"]["publication"].clone();
        assert_eq!(publication["draft"]["publicationId"], PUBLICATION);
        assert_eq!(publication["version"], 1);
        assert_eq!(publication["pages"][0]["source"], *fixed);
        if adopt {
            let response = integration_memory_request(
                server,
                11,
                "integrations/knowledge/adoptPublication",
                scope,
                Some("explicitly-adopt-material-r1"),
                Some(0),
                json!({"owner":publication["owner"],"publicationId":PUBLICATION,"version":1}),
            );
            assert_eq!(response["result"]["status"], "completed", "{response}");
            assert_eq!(
                response["result"]["result"]["adoption"]["publicationVersion"],
                1
            );
            assert_eq!(response["result"]["result"]["adoption"]["enabled"], true);
        }
        publication
    }

    fn change_current_wiki_to_r2(profile: &Path, fixed: &Value) {
        let scope = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
            &format!("profile:{}", profile.canonicalize().unwrap().display()),
            "execution-host",
        )
        .unwrap();
        let mut store =
            kcoder_knowledge::KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))
                .unwrap();
        store
            .edit_page(
                &scope,
                fixed["libraryId"].as_str().unwrap(),
                fixed["pageId"].as_str().unwrap(),
                fixed["pageRevision"].as_str().unwrap(),
                "human-current-page-r2",
                "New current Wiki r2",
                "CURRENT_R2_MUST_NOT_REPLACE_THE_ADOPTED_R1_SOURCE",
            )
            .unwrap();
    }

    fn start_material_turn(server: &mut TestAppServer, workspace: &Path) -> (String, String) {
        server.send(json!({"id":20,"method":"thread/start","params":{"cwd":workspace,"studioWorkMode":"kworker"}}));
        let response = server.response(20);
        assert!(response.get("error").is_none(), "{response}");
        let thread = response["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        server.send(json!({"id":21,"method":"turn/start","params":{"threadId":thread,
            "clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":false},
            "input":[{"type":"text","text":"Generate the real DOCX from my explicitly selected publication version 1. Keep source revisions fixed; preserve the unknown responsible person. If source authority is unavailable, do not publish a substitute artifact."}]}}));
        let response = server.response(21);
        assert!(response.get("error").is_none(), "{response}");
        (
            thread,
            response["result"]["turn"]["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        )
    }

    fn finish_material_turn(server: &TestAppServer, thread: &str, turn: &str) {
        let deadline = Instant::now() + Duration::from_secs(100);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["threadId"] == thread {
                assert_eq!(event["params"]["turn"]["id"], turn, "{event}");
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                return;
            }
        }
    }

    #[test]
    #[ignore = "Requires explicit real staged Office/Node observation; native fixed material stdio gate"]
    fn integration_office_stdio_fixed_publication_material_chain_and_authorization_windows() {
        let launch = launch_observation();
        for case in [
            MaterialCase::Adopted,
            MaterialCase::MissingAdoption,
            MaterialCase::RevokedAfterAcceptedDiscovery,
        ] {
            let root = tempfile::tempdir().unwrap();
            let (workspace, profile, config) = profile(root.path());
            let (fixed, text) = seed_fixed_wiki(&profile);
            let report_text = text.clone();
            let (ready_tx, ready_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
                move |index, request| match index {
                    0 => FixtureAnswer::Tool {
                        id: DISCOVERY.into(),
                        name: "tool_search".into(),
                        input: json!({"query":"OfficeDocument","limit":1}),
                    },
                    1 => {
                        let discovered = discovery_result(request, DISCOVERY);
                        assert_eq!(
                            discovered["tools"][0]["name"], "OfficeDocument",
                            "{discovered}"
                        );
                        if case == MaterialCase::RevokedAfterAcceptedDiscovery {
                            ready_tx.send(()).unwrap();
                            release_rx.recv_timeout(Duration::from_secs(20)).expect(
                                "public native revoke ACK before actual document execution",
                            );
                        }
                        FixtureAnswer::Tool {
                            id: DOCUMENT.into(),
                            name: "tool_execute".into(),
                            input: json!({"tool_name":"OfficeDocument","arguments":{"specification":{"schemaVersion":1,"kind":"docx",
                            "title":"Actual fixed publication material report","paragraphs":[{"text":report_text}]},
                            "sourceRefs":[{"kind":"publication","id":PUBLICATION,"revision":"1"}]}}),
                        }
                    }
                    2 => {
                        let result = tool_result(request, DOCUMENT)
                            .expect("actual OfficeDocument result reaches next model request");
                        if case == MaterialCase::Adopted {
                            assert_eq!(result["format"], "docx", "{result}");
                            assert!(result["artifactRef"]["id"].is_string(), "{result}");
                        } else {
                            assert!(
                                result["artifactRef"].is_null(),
                                "{case:?}: denied source must not produce an artifact: {result}"
                            );
                            let error = serde_json::to_string(&result).unwrap();
                            assert!(
                                error.contains("OFFICE_SOURCE_IDENTITIES_UNAVAILABLE")
                                    || error.contains("OFFICE_ACCESS_DENIED"),
                                "{case:?}: preserve explicit source failure: {result}"
                            );
                        }
                        FixtureAnswer::Text(if case == MaterialCase::Adopted {
                            "The actual native DOCX was saved from fixed source r1; correctness review remains separate.".into()
                        } else {
                            "No artifact was published because fixed source authorization was unavailable.".into()
                        })
                    }
                    _ => panic!(
                        "unexpected extra model call in bounded native material case {case:?}"
                    ),
                },
                Some(3),
                Duration::from_secs(60),
            );
            settings(&config, &endpoint, true);
            let mut configured: Value =
                serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
            configured["knowledge"] = json!({"enabled":true});
            configured["integrations"]["knowledge"] = json!({"publications_enabled":true});
            std::fs::write(&config, serde_json::to_vec(&configured).unwrap()).unwrap();
            let mut builder = TestAppServer::builder(&workspace, &config)
                .config_dir(&profile)
                .without_scenario()
                .env(OFFICE_ENV, startup(&launch))
                .env(PARENT_ENV, parent());
            builder.training_mode = true;
            let mut server = builder.spawn();
            let native_scope = initialize_material_controls(&mut server);
            let publication = publish_material(
                &mut server,
                &native_scope,
                &fixed,
                case != MaterialCase::MissingAdoption,
            );
            assert_eq!(publication["pages"][0]["markdown"], text);
            change_current_wiki_to_r2(&profile, &fixed);
            let expected_input_sha = format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(
                        &json!({"schemaVersion":1,"kind":"publication","publication":publication})
                    )
                    .unwrap()
                )
            );
            let (thread, turn) = start_material_turn(&mut server, &workspace);
            if case == MaterialCase::RevokedAfterAcceptedDiscovery {
                ready_rx
                    .recv_timeout(Duration::from_secs(30))
                    .expect("actual Accepted continuation after Office discovery");
                let response = integration_memory_request(
                    &mut server,
                    12,
                    "integrations/knowledge/revokePublication",
                    &native_scope,
                    Some("revoke-after-accepted-discovery"),
                    Some(1),
                    json!({"owner":publication["owner"],"publicationId":PUBLICATION,"version":1}),
                );
                assert_eq!(response["result"]["status"], "completed", "{response}");
                release_tx.send(()).unwrap();
            }
            finish_material_turn(&server, &thread, &turn);
            let recorded = calls.lock().unwrap();
            assert_eq!(
                recorded.len(),
                3,
                "{case:?}: no extra inference or Observer"
            );
            let projected = tool_result(&recorded[2], DOCUMENT).unwrap();
            drop(recorded);
            server.shutdown();
            fixture.join().unwrap();
            let path = find_named_file(&profile, "office-state.json");
            if case != MaterialCase::Adopted && path.is_none() {
                continue;
            }
            let path = path
                .expect("actual native Office store required for successful material generation");
            let snapshot: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let owner: IntegrationOwner =
                serde_json::from_value(snapshot["owner"].clone()).unwrap();
            let store = OfficeStore::open_existing(path.parent().unwrap(), owner)
                .unwrap()
                .unwrap();
            let artifacts = store.list_artifacts(&thread).unwrap();
            if case != MaterialCase::Adopted {
                assert!(artifacts.is_empty(), "{case:?}: no artifact publication");
                continue;
            }
            assert_eq!(artifacts.len(), 1);
            let manifest = &artifacts[0];
            assert_eq!(manifest.task.turn_id, turn);
            assert_eq!(
                manifest.format,
                kcoder_types::integrations::office::OfficeFileFormat::Docx
            );
            let reference: OfficeArtifactRef =
                serde_json::from_value(projected["artifactRef"].clone()).unwrap();
            assert_eq!(reference.id, manifest.id);
            let (bytes, total) = store
                .read_artifact_chunk(&reference, 0, 512 * 1024)
                .unwrap();
            assert!(bytes.starts_with(b"PK"));
            assert_eq!(bytes.len() as u64, total);
            assert_eq!(total, manifest.bytes);
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), manifest.sha256);
            assert_eq!(projected["sha256"], manifest.sha256);
            let canonical = store
                .read_canonical_source(&reference, None, 0, 65536, true)
                .unwrap()
                .source
                .unwrap();
            assert_eq!(canonical.task.turn_id, turn);
            assert_eq!(canonical.inputs.len(), 1);
            assert_eq!(canonical.inputs[0].reference.kind, "publication");
            assert_eq!(canonical.inputs[0].reference.id, PUBLICATION);
            assert_eq!(canonical.inputs[0].reference.revision, "1");
            assert_eq!(canonical.inputs[0].sha256, expected_input_sha);
            let source = store
                .read_canonical_source(
                    &reference,
                    Some(&canonical.specification_sha256),
                    0,
                    65536,
                    false,
                )
                .unwrap();
            assert!(source.complete);
            let full = source.chunk.unwrap();
            assert!(full.contains("FIXED_R1_TAIL_BEYOND_PREVIEW"));
            assert!(!full.contains("CURRENT_R2_MUST_NOT_REPLACE"));
            assert_eq!(
                format!("{:x}", Sha256::digest(full.as_bytes())),
                canonical.specification_sha256
            );
        }
    }
}
