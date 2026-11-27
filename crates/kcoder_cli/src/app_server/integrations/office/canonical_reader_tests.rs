//! Actual discovered OfficeData -> tool_execute -> private canonical source.
//! The recording Provider is deterministic; generation uses explicit real Node.
use super::*;

fn result(engine: &QueryEngine, call: &str) -> (bool, Value) {
    engine
        .state
        .messages()
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::User { content, .. } => content.iter().find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } if tool_use_id == call => {
                    let text = content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>();
                    Some((
                        is_error.unwrap_or(false),
                        serde_json::from_str(&text).unwrap_or_else(|_| json!({"errorText":text})),
                    ))
                }
                _ => None,
            }),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing actual tool receipt {call}"))
}
async fn send(
    fixture: &Fixture,
    engine: &QueryEngine,
    call: &str,
    name: &str,
    input: Value,
) -> (bool, Value) {
    fixture
        .provider
        .script
        .lock()
        .unwrap()
        .push_back(ContentBlock::ToolUse {
            id: call.into(),
            name: name.into(),
            input,
        });
    let events = engine
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 3)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
        "{events:?}"
    );
    result(engine, call)
}
async fn read(fixture: &Fixture, engine: &QueryEngine, call: &str, input: Value) -> (bool, Value) {
    send(
        fixture,
        engine,
        call,
        "tool_execute",
        json!({"tool_name":"OfficeData","arguments":input}),
    )
    .await
}
async fn generate(fixture: &Fixture, engine: &QueryEngine) -> OfficeArtifactManifest {
    let events = engine
        .submit_message_stream(
            "Generate the complete literal DOCX source for a controlled reader acceptance",
            &kcoder_permissions::AutoAllowPrompt,
        )
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
        "{events:?}"
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while engine.state.session_memory().is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "owned memory task did not settle"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let manifests = fixture
        .composition()
        .service()
        .store
        .list_artifacts(&fixture.identity.thread_id)
        .unwrap();
    assert_eq!(manifests.len(), 1);
    manifests[0].clone()
}

#[tokio::test]
#[ignore = "Requires explicit actual Node; selected canonical-source tool acceptance"]
async fn actual_discovered_reader_pages_exact_native_source_and_rejects_invalid_or_unauthorized_refs()
-> Result<()> {
    let fixture = Fixture::new();
    let engine = fixture.install();
    let manifest = generate(&fixture, &engine).await;
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    assert!(engine.active_tool_registry().get("OfficeData").is_none());
    let (failed, _) = read(
        &fixture,
        &engine,
        "before-reader-discovery",
        json!({"action":"canonical_source","reference":reference}),
    )
    .await;
    assert!(
        failed,
        "the Native reader is deferred, not callable without discovery"
    );
    let (failed, discovered) = send(
        &fixture,
        &engine,
        "discover-canonical-reader",
        "tool_search",
        json!({"query":"OfficeData","limit":1}),
    )
    .await;
    assert!(!failed, "{discovered:?}");
    assert!(
        engine.active_tool_registry().get("OfficeData").is_none(),
        "discovery must not mutate the top-level tool schema"
    );
    let (failed, metadata) = read(
        &fixture,
        &engine,
        "reader-metadata",
        json!({"action":"canonical_source","reference":reference}),
    )
    .await;
    assert!(!failed, "{metadata:?}");
    assert_eq!(metadata["availability"], "available");
    assert_eq!(metadata["chunk"], Value::Null);
    assert_eq!(metadata["coversEntireSource"], false);
    assert_eq!(metadata["returnedBytes"], 0);
    let sha = metadata["source"]["specificationSha256"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(
        sha, manifest.sha256,
        "source SHA differs from the DOCX output SHA"
    );
    let mut offset = 0u64;
    let mut joined = String::new();
    let mut pages = 0;
    loop {
        let (failed,page)=read(&fixture,&engine,&format!("reader-page-{pages}"),json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"expectedSha256":sha,"offset":offset,"limit":8192}})).await;
        assert!(!failed, "{page:?}");
        assert_eq!(page["offset"], offset);
        assert_eq!(page["source"]["artifact"], json!(reference));
        let chunk = page["chunk"].as_str().unwrap();
        assert!(chunk.len() <= 8192);
        assert_eq!(page["returnedBytes"], chunk.len());
        joined.push_str(chunk);
        pages += 1;
        assert!(
            pages < 20,
            "bounded source must finish within its recorded byte count"
        );
        if page["complete"] == true {
            assert_eq!(page["nextOffset"], Value::Null);
            assert_eq!(
                page["coversEntireSource"], false,
                "a final partial page does not contain earlier source bytes"
            );
            break;
        }
        let next = page["nextOffset"].as_u64().unwrap();
        assert_eq!(next, offset + chunk.len() as u64);
        offset = next;
    }
    assert!(pages > 1);
    assert_eq!(format!("{:x}", Sha256::digest(joined.as_bytes())), sha);
    let (failed, whole) = read(&fixture, &engine, "reader-upper-byte-limit", json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"expectedSha256":sha,"offset":0,"limit":65536}})).await;
    assert!(!failed, "{whole:?}");
    assert_eq!(whole["complete"], false);
    assert_eq!(whole["coversEntireSource"], false);
    assert_eq!(whole["pageLimit"], 16384);
    let bounded = whole["chunk"].as_str().unwrap();
    assert!(bounded.len() <= 16384);
    assert!(joined.starts_with(bounded));
    assert_eq!(whole["returnedBytes"], bounded.len());
    assert_eq!(whole["nextOffset"], bounded.len());
    let source: Value = serde_json::from_str(&joined)?;
    assert_eq!(
        source["paragraphs"],
        fixture.provider.arguments["specification"]["paragraphs"]
    );
    for (call, input) in [
        (
            "reader-wrong-sha",
            json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"expectedSha256":"0".repeat(64),"offset":0,"limit":8192}}),
        ),
        (
            "reader-old-revision",
            json!({"action":"canonical_source","reference":{"id":reference.id,"revision":reference.revision+1}}),
        ),
        (
            "reader-missing-sha",
            json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"offset":0,"limit":8192}}),
        ),
        (
            "reader-offset-past-end",
            json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"expectedSha256":sha,"offset":joined.len()+1,"limit":8192}}),
        ),
        (
            "reader-over-limit",
            json!({"action":"canonical_source","reference":reference,"sourceRead":{"metadataOnly":false,"expectedSha256":sha,"offset":0,"limit":65537}}),
        ),
    ] {
        let (failed, value) = read(&fixture, &engine, call, input).await;
        assert!(failed, "{call}: {value:?}");
        assert!(value.get("chunk").is_none());
    }
    // A real separate native owner/workspace contains another actual generated
    // artifact; knowing that ID/hash does not make it readable in this namespace.
    let other = Fixture::new();
    let other_engine = other.install();
    let foreign = generate(&other, &other_engine).await;
    assert_ne!(foreign.owner, manifest.owner);
    let foreign_source = other.composition().service().store.read_canonical_source(
        &OfficeArtifactRef {
            id: foreign.id.clone(),
            revision: foreign.revision,
        },
        None,
        0,
        65536,
        true,
    )?;
    assert_eq!(
        foreign_source.source.unwrap().specification_sha256,
        sha,
        "identical content SHA does not grant cross-owner authority"
    );
    let (failed,value)=read(&fixture,&engine,"reader-other-owner",json!({"action":"canonical_source","reference":{"id":foreign.id,"revision":foreign.revision}})).await;
    assert!(failed, "{value:?}");
    // This is a real Engine permission revocation after actual native discovery.
    engine
        .permissions
        .write()
        .unwrap()
        .denied_tools
        .push("OfficeData".into());
    let (failed, value) = read(
        &fixture,
        &engine,
        "reader-denied",
        json!({"action":"canonical_source","reference":reference}),
    )
    .await;
    assert!(failed, "{value:?}");
    assert_eq!(
        fixture
            .composition()
            .service()
            .store
            .list_artifacts(&fixture.identity.thread_id)?
            .len(),
        1,
        "reading did not generate an edited document or allocate a second artifact"
    );
    let _idle = wait_idle(&engine).await;
    let _other_idle = wait_idle(&other_engine).await;
    capture_requests(
        "canonical-reader-explicit-read",
        &fixture.provider.requests.lock().unwrap(),
    )?;
    Ok(())
}

async fn wait_idle(engine: &QueryEngine) -> kcoder_engine::BackgroundWorkIdleReservation {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(reservation) = engine.try_reserve_background_work_idle() {
            return reservation;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "owned background work did not settle before fixture cleanup"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
