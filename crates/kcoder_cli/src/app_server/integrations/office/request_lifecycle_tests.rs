//! Combined actual native source/material/request lifecycle; no live model.
use super::*;
use crate::app_server::{
    ConnectionState, SessionLease, engine_factory::AppServerEngineFactory,
    transcript_projection::prepare_persisted_thread_resume,
};
use anyhow::{Context, ensure};
use kcoder_engine::{EngineEvent, WorkspaceRuntimeServices, context::TokenCounter};
use kcoder_types::integrations::core::IntegrationTaskCapabilityScopeMode;
#[path = "request_lifecycle_tests/provider.rs"]
mod provider;
#[path = "request_lifecycle_tests/sources.rs"]
mod sources;
use provider::LifecycleProvider;
use sources::Sources;

fn presentation() -> ClientPresentationV1 {
    ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(StudioWorkMode::Kworker),
        inline_widgets: true,
        isolated_widgets: false,
    }
}
fn digest(value: &impl serde::Serialize) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}
fn restore_observation(phase: &str, value: &Value) -> Result<()> {
    eprintln!("actual context restore observation {phase}: {value}");
    if let Some(directory) = std::env::var_os("KCODER_OFFICE_DEFERRED_CAPTURE_DIR") {
        let directory = Path::new(&directory);
        std::fs::create_dir_all(directory)?;
        std::fs::write(
            directory.join(format!("actual-context-restore-{phase}.json")),
            serde_json::to_vec_pretty(value)?,
        )?;
    }
    Ok(())
}
fn compact_envelope_matches(live: &Message, durable: &Message) -> bool {
    match (live, durable) {
        (
            Message::User {
                content: left,
                origin: lo,
            },
            Message::User {
                content: right,
                origin: ro,
            },
        ) if lo == &kcoder_types::MessageOrigin::Compaction && ro == lo => {
            match (left.as_slice(), right.as_slice()) {
                ([ContentBlock::Text { text: left }], [ContentBlock::Text { text: right }]) => {
                    left == right
                        || left.strip_prefix("<!--kcoder:compact-boundary-->\n")
                            == Some(right.as_str())
                }
                _ => false,
            }
        }
        _ => false,
    }
}
fn first_difference(left: &[Message], right: &[Message]) -> Option<usize> {
    left.iter()
        .zip(right)
        .position(|(left, right)| left != right)
        .or_else(|| (left.len() != right.len()).then_some(left.len().min(right.len())))
}
async fn turn(engine: &QueryEngine, identity: &TurnAttemptIdentity, text: &str) -> Result<()> {
    let events = engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(async {
            engine
                .submit_message_stream(text, &kcoder_permissions::AutoAllowPrompt)
                .collect::<Vec<_>>()
                .await
        })
        .await;
    ensure!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_))),
        "{events:?}"
    );
    Ok(())
}
fn tool_result(engine: &QueryEngine, call: &str) -> Result<(bool, String)> {
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
                } if tool_use_id == call => Some((
                    is_error.unwrap_or(false),
                    content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>(),
                )),
                _ => None,
            }),
            _ => None,
        })
        .context("actual original tool receipt required")
}
fn manifests(
    context: &NativeIntegrationContext,
    engine: &QueryEngine,
    paths: &NativeOfficeInstalledPaths,
) -> Result<(NativeOfficeComposition, Vec<OfficeArtifactManifest>)> {
    let composition = NativeOfficeComposition::observe(
        context,
        engine,
        paths.clone(),
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            ..Default::default()
        },
    )?
    .context("actual generated Office namespace")?;
    let manifests = composition
        .service()
        .store
        .list_artifacts(&engine.session_id())?;
    Ok((composition, manifests))
}
fn canonical(
    composition: &NativeOfficeComposition,
    manifest: &OfficeArtifactManifest,
) -> Result<Value> {
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    let metadata =
        composition
            .service()
            .store
            .read_canonical_source(&reference, None, 0, 64 * 1024, true)?;
    let source = metadata
        .source
        .context("actual immutable canonical source")?;
    let content = composition.service().store.read_canonical_source(
        &reference,
        Some(&source.specification_sha256),
        0,
        64 * 1024,
        false,
    )?;
    ensure!(
        content.complete,
        "bounded canonical source must be complete"
    );
    let bytes = content.chunk.context("actual canonical bytes")?;
    ensure!(
        format!("{:x}", Sha256::digest(bytes.as_bytes())) == source.specification_sha256,
        "canonical hash"
    );
    Ok(
        json!({"artifact":reference,"descriptor":source,"bodyBytes":bytes.len(),"bodySha256":format!("{:x}",Sha256::digest(bytes.as_bytes()))}),
    )
}
fn capture(provider: &LifecycleProvider, evidence: &mut Value) -> Result<()> {
    let captured = provider.captured.lock().unwrap();
    let main: Vec<_> = captured
        .iter()
        .filter(|(_, request)| {
            !is_session_memory_request(request) && !LifecycleProvider::is_compact(request)
        })
        .collect();
    let baseline = main
        .first()
        .context("actual first Engine request")?
        .1
        .clone();
    let references = provider.summary_refs.lock().unwrap().clone();
    ensure!(references.len() == 2, "two actual immutable references");
    let mut rows = Vec::new();
    for (index, (phase, request)) in captured.iter().enumerate() {
        let body = serde_json::to_string(request)?;
        ensure!(
            !body.contains("DEFERRED_CANONICAL_LITERAL")
                && !body.contains("ADDED_CANONICAL_LITERAL"),
            "canonical bodies repeated in actual request {phase}/{index}"
        );
        let is_main =
            !is_session_memory_request(request) && !LifecycleProvider::is_compact(request);
        if is_main {
            ensure!(
                request.system == baseline.system,
                "main system prefix changed at {phase}/{index}"
            );
            ensure!(
                serde_json::to_value(&request.tools)? == serde_json::to_value(&baseline.tools)?,
                "main top-level tools changed at {phase}/{index}"
            );
        }
        let wrapper = wrapped_input(&request.messages);
        if let Some(input) = &wrapper {
            ensure!(
                input["arguments"]
                    .get("_storedOfficeGenerationSource")
                    .is_some(),
                "original wrapper must use actual receipt"
            );
            ensure!(
                serde_json::to_vec(input)?.len() <= 4096,
                "bounded original reference"
            );
        }
        if is_main && matches!(*phase, "repeat" | "compacted" | "reopened") {
            for reference in &references {
                ensure!(
                    body.contains(reference.id.as_str()),
                    "immutable artifact ref lost at {phase}/{index}"
                );
            }
        }
        let estimate = TokenCounter::count_request(request, true);
        ensure!(
            body.len() < 256 * 1024,
            "bounded actual request including system/tools"
        );
        rows.push(json!({"index":index,"phase":phase,"kind":if LifecycleProvider::is_compact(request){"real_compaction"}else if is_main{"main"}else{"session_memory"},
            "requestBytes":body.len(),"requestSha256":format!("{:x}",Sha256::digest(body.as_bytes())),
            "systemSha256":digest(&request.system),"topToolsSha256":digest(&request.tools),
            "canonicalBodyOccurrences":0,"originalWrapperBytes":wrapper.as_ref().map(|input|serde_json::to_vec(input).unwrap().len()),
            "storedSourceMarkers":body.matches("_storedOfficeGenerationSource").count(),
            "immutableArtifactRefOccurrences":references.iter().map(|reference|body.matches(reference.id.as_str()).count()).collect::<Vec<_>>(),
            "localFullRequestTokens":estimate.tokens,"localCountSource":format!("{:?}",estimate.source),
            "controlledTransportUsage":null,"usageAvailability":"not_reported_by_fixture",
            "realVendorUsage":null,"cacheHitClaim":false}));
    }
    for phase in ["first", "repeat", "compacted", "reopened"] {
        ensure!(
            main.iter().any(|(seen, _)| seen == &phase),
            "missing actual main phase {phase}"
        );
    }
    ensure!(
        captured
            .iter()
            .any(|(_, request)| LifecycleProvider::is_compact(request)),
        "actual summarizer request required"
    );
    evidence["requests"] = json!(rows);
    evidence["productionRequestAssemblyVerified"] = json!(true);
    evidence["realVendorUsageVerified"] = json!(false);
    evidence["cacheHitVerified"] = json!(false);
    if let Some(directory) = std::env::var_os("KCODER_OFFICE_DEFERRED_CAPTURE_DIR") {
        let directory = Path::new(&directory);
        std::fs::create_dir_all(directory)?;
        std::fs::write(
            directory.join("actual-source-material-context-lifecycle-requests.json"),
            serde_json::to_vec_pretty(&*captured)?,
        )?;
        std::fs::write(
            directory.join("actual-source-material-context-lifecycle-evidence.json"),
            serde_json::to_vec_pretty(evidence)?,
        )?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "Requires explicit actual Node and owned local Python MCP; no external model"]
async fn actual_source_switch_new_material_first_repeat_real_compact_target_reopen_preserve_prefix_and_bounded_refs()
-> Result<()> {
    let temp = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_existing(temp.path())?;
    for name in ["profile", "workspace", "history", "peer"] {
        directory.create_private_child(OsStr::new(name))?;
    }
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    let history = temp.path().join("history");
    let peer = temp.path().join("peer");
    let context = Arc::new(NativeIntegrationContext::capture(
        &profile,
        &workspace,
        "owned-context-lifecycle",
        "config-r1",
    )?);
    let config: kcoder_types::McpServerConfig = serde_json::from_value(json!({
        "name":"ctx-owned","transport":"stdio","command":"python3",
        "args":[kcoder_test_harness::workspace_root().expect("resolve current workspace").join("crates/kcoder_cli").join("../kcoder_mcp/tests/fixtures/lifecycle_server.py"),"effect",peer]
    }))?;
    let credentials = kcoder_mcp::server_policy::CredentialContext {
        config_dir: profile.clone(),
        mode: kcoder_config::CredentialStoreMode::File,
    };
    let (handle, definitions) = kcoder_mcp::connect_server_with_private_values_in(
        &config,
        None,
        Arc::new(kcoder_mcp::tool::PrivateValues::default()),
        Some(&credentials),
    )
    .await?;
    let tool: Arc<dyn kcoder_tools::Tool> = Arc::new(
        kcoder_mcp::McpTool::new(
            &config.name,
            handle.clone(),
            definitions
                .into_iter()
                .next()
                .context("actual tools/list")?,
        )
        .with_credential_context(credentials),
    );
    let source_tool = tool.name().to_string();
    let result = run(RunInputs {
        context,
        workspace,
        history,
        peer,
        config,
        tool,
        source_tool,
    })
    .await;
    handle.lock().await.close();
    result
}

struct RunInputs {
    context: Arc<NativeIntegrationContext>,
    workspace: std::path::PathBuf,
    history: std::path::PathBuf,
    peer: std::path::PathBuf,
    config: kcoder_types::McpServerConfig,
    tool: Arc<dyn kcoder_tools::Tool>,
    source_tool: String,
}
async fn run(inputs: RunInputs) -> Result<()> {
    let RunInputs {
        context,
        workspace,
        history,
        peer,
        config,
        tool,
        source_tool,
    } = inputs;
    let storage = Arc::new(kcoder_config::create_private_temp_dir(
        "owned-context-lifecycle-storage",
    )?);
    let provider = Arc::new(LifecycleProvider::new());
    let mut settings = kcoder_config::Settings {
        history_enabled: true,
        credential_store: kcoder_config::CredentialStoreMode::File,
        context_window_tokens: Some(1_000_000),
        context_output_headroom: Some(10_000),
        max_tokens: Some(1024),
        mcp_servers: vec![config],
        ..Default::default()
    };
    settings.integrations.office.enabled = true;
    // This scene owns only foreground work: exercise the real compactor,
    // without a concurrent memory writer surviving the old lease boundary.
    settings.session_memory.enabled = false;
    settings.session_memory.compact_enabled = false;
    let factory = AppServerEngineFactory::new(
        provider.clone(),
        ToolRegistry::new().register_arc(tool),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Default::default(),
        workspace.clone(),
        Some(history),
        true,
        WorkspaceRuntimeServices::new(&workspace, "owned-context-lifecycle")
            .with_private_client_storage(storage),
        Some(context.profile_path()?.join("settings.json")),
        context.profile_path()?.join("short-ids.json"),
    );
    let raw = factory
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?
        .with_client_presentation(Some(presentation()));
    let lease = SessionLease::acquire(&raw.session_lease_target())?;
    let old_witness = lease.native_witness()?;
    let old_lifecycle = raw.state.inspection_lifecycle_identity();
    let identity = TurnAttemptIdentity {
        thread_id: raw.session_id(),
        turn_id: "ctx-original-turn".into(),
        attempt_id: "ctx-original-attempt".into(),
    };
    TurnAttemptStore::open(
        &raw.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .begin(TurnAttemptRecord {
        client_presentation: Some(presentation()),
        version: 1,
        identity: identity.clone(),
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: digest(&raw.state.messages()),
        request_fingerprint: Some(digest(&json!(["ctx-original-native-request", identity]))),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    let node = std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE")
        .context("explicit actual Node required")?;
    let paths = NativeOfficeInstalledPaths::from_native_installation(
        Path::new(&node),
        &kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components"),
    )?;
    let office_providers = || NativeOfficeProviders {
        tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
        ..Default::default()
    };
    let engine = install_office_for_accepted_turn(
        &context,
        &identity,
        raw,
        paths.clone(),
        office_providers(),
        "ctx-office-r1".into(),
    )?;
    let sources = Sources::capture(&context, &engine, &lease, &factory, &identity).await?;
    let engine = engine.with_native_tool_authorization(sources.guard.clone());
    turn(
        &engine,
        &identity,
        "Generate the first full DOCX using the actual Office capability",
    )
    .await?;
    let (composition, first) = manifests(&context, &engine, &paths)?;
    ensure!(first.len() == 1, "actual first generation");
    let original = canonical(&composition, &first[0])?;
    let first_history = engine.state.messages();
    ensure!(
        wrapped_input(&SharedMessages::from(first_history.clone())).is_some(),
        "real original generation call"
    );
    provider.phase("source-none");
    provider.tool(
        "ctx-source-discover",
        "tool_search",
        json!({"query":source_tool,"limit":1}),
    );
    turn(
        &engine,
        &identity,
        "Discover the configured owned source; this grants no use",
    )
    .await?;
    provider.tool(
        "ctx-source-denied",
        "tool_execute",
        json!({"tool_name":source_tool,"arguments":{}}),
    );
    turn(
        &engine,
        &identity,
        "Attempt the original source while the native selection is none",
    )
    .await?;
    ensure!(
        tool_result(&engine, "ctx-source-denied")?.0,
        "none must deny the actual source"
    );
    ensure!(
        !peer.join("called").exists(),
        "denied source must not execute"
    );
    let switched = sources.inherit(&context, &engine, &lease).await?;
    provider.phase("source-inherited");
    provider.tool(
        "ctx-source-allowed",
        "tool_execute",
        json!({"tool_name":source_tool,"arguments":{}}),
    );
    turn(
        &engine,
        &identity,
        "Use the source after the original signed native selection boundary",
    )
    .await?;
    ensure!(
        !tool_result(&engine, "ctx-source-allowed")?.0,
        "inherited source must execute"
    );
    ensure!(
        peer.join("effect").exists(),
        "actual owned source effect receipt"
    );
    ensure!(
        engine.state.messages().starts_with(&first_history),
        "source switch changed original history"
    );
    provider.phase("new-material");
    let second: Value = serde_json::from_str(
        &serde_json::to_string(&arguments())?
            .replace("DEFERRED_CANONICAL_LITERAL_", "ADDED_CANONICAL_LITERAL_"),
    )?;
    provider.tool(
        "ctx-added-generation",
        "tool_execute",
        json!({"tool_name":"OfficeDocument","arguments":second}),
    );
    turn(
        &engine,
        &identity,
        "Append a second independently generated canonical document; preserve the first",
    )
    .await?;
    ensure!(
        !tool_result(&engine, "ctx-added-generation")?.0,
        "second actual Node generation"
    );
    let (_, both) = manifests(&context, &engine, &paths)?;
    ensure!(both.len() == 2, "two real canonical materials");
    ensure!(
        both.iter().any(|item| item == &first[0]),
        "original manifest identity drift"
    );
    ensure!(
        canonical(&composition, &first[0])? == original,
        "original canonical source changed"
    );
    ensure!(
        engine.state.messages().starts_with(&first_history),
        "material addition changed original history"
    );
    let canonical_before: Vec<_> = both
        .iter()
        .map(|item| canonical(&composition, item))
        .collect::<Result<_>>()?;
    *provider.summary_refs.lock().unwrap() = both
        .iter()
        .map(|item| OfficeArtifactRef {
            id: item.id.clone(),
            revision: item.revision,
        })
        .collect();
    provider.phase("repeat");
    turn(
        &engine,
        &identity,
        "Repeat using only immutable references; no document body",
    )
    .await?;
    engine.state.flush_history().await?;
    let history_path = engine
        .state
        .history_path()
        .context("real persistent history")?;
    let immutable_prefix = std::fs::read(&history_path)?;
    let original_transcript = kcoder_state::load_transcript_history(&history_path)?;
    provider.phase("compact-summary");
    let compacted = engine
        .state
        .history_attempt_scope(identity.clone())?
        .run(engine.compact_conversation())
        .await?;
    ensure!(
        compacted.did_compact && !compacted.summary.is_empty(),
        "real Engine full compaction required"
    );
    ensure!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.origin() == kcoder_types::MessageOrigin::Compaction),
        "actual compact boundary"
    );
    engine.state.flush_history().await?;
    ensure!(
        std::fs::read(&history_path)?.starts_with(&immutable_prefix),
        "compaction rewrote physical history"
    );
    let compact_transcript = kcoder_state::load_transcript_history(&history_path)?;
    for entry in &original_transcript {
        ensure!(
            compact_transcript
                .iter()
                .any(|current| current.uuid == entry.uuid && current.message == entry.message),
            "original UUID/message changed at compact"
        );
    }
    provider.phase("compacted");
    turn(
        &engine,
        &identity,
        "Continue after actual compaction using immutable references",
    )
    .await?;
    engine.state.flush_history().await?;
    let model_before = engine.state.messages();
    // Resume reconstructs the model context from authoritative compact-boundary
    // JSONL, rather than serializing the transient live Engine representation.
    let persisted_model_before: Vec<_> = kcoder_state::load_history(&history_path)?
        .into_iter()
        .map(|entry| entry.message)
        .collect();
    let live_boundary = kcoder_engine::context::latest_compact_boundary(&model_before)
        .context("live actual compact boundary")?;
    let durable_boundary = kcoder_engine::context::latest_compact_boundary(&persisted_model_before)
        .context("authoritative persisted actual compact boundary")?;
    let original_context_observation = json!({
        "phase":"before_original_lease_release", "liveMessages":model_before.len(),
        "durableMessages":persisted_model_before.len(),"liveSha256":digest(&model_before),
        "durableSha256":digest(&persisted_model_before),
        "firstDifference":first_difference(&model_before,&persisted_model_before),
        "liveSummarySha256":digest(&live_boundary.summary),
        "durableSummarySha256":digest(&durable_boundary.summary),
        "summaryBodyEqual":live_boundary.summary==durable_boundary.summary,
        "preservedTailExact":model_before.get(1..)==persisted_model_before.get(1..),
        "onlyKnownInternalEnvelopeDifference":model_before.first().zip(persisted_model_before.first())
            .is_some_and(|(live,durable)|compact_envelope_matches(live,durable)),
    });
    restore_observation("before-target-reopen", &original_context_observation)?;
    ensure!(
        model_before.len() == persisted_model_before.len()
            && model_before.get(1..) == persisted_model_before.get(1..)
            && live_boundary.summary == durable_boundary.summary
            && model_before
                .first()
                .zip(persisted_model_before.first())
                .is_some_and(|(live, durable)| compact_envelope_matches(live, durable)),
        "live versus durable compact context changed beyond its known internal envelope"
    );
    let source_before = sources
        .binding
        .snapshot(&context, sources.facts.as_ref())
        .await?;
    let usage_before = engine.cumulative_usage();
    ensure!(
        usage_before.total_tokens == 0
            && usage_before.input_tokens == 0
            && usage_before.output_tokens == 0,
        "unavailable usage must not become a fabricated measured count"
    );
    let original_target = engine.session_lease_target();
    drop(composition);
    drop(sources);
    drop(engine);
    drop(lease);
    ensure!(
        old_witness.verify_target(&original_target).is_err(),
        "old lease must end before target reopen"
    );
    let bootstrap = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    let (prepared, new_lease, _) =
        prepare_persisted_thread_resume(&bootstrap, &identity.thread_id)?;
    let (resumed, _) = factory
        .resume_fresh_thread_with_template(
            None,
            None,
            prepared,
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
        )
        .await?;
    let resumed = resumed.with_client_presentation(Some(presentation()));
    ensure!(
        new_lease.matches_target(&resumed.session_lease_target())
            && resumed.session_id() == identity.thread_id,
        "same thread real new lease"
    );
    ensure!(
        !old_lifecycle.matches(&resumed.state),
        "target reopen must create a different State lifecycle"
    );
    ensure!(
        old_witness.verify_target(&original_target).is_err(),
        "new lease cannot revive old owner"
    );
    let reopened_model = resumed.state.messages();
    restore_observation(
        "after-target-reopen",
        &json!({
            "phase":"new_state_and_new_real_session_lease", "durableMessages":persisted_model_before.len(),
            "reopenedMessages":reopened_model.len(),"durableSha256":digest(&persisted_model_before),
            "reopenedSha256":digest(&reopened_model),
            "firstDifference":first_difference(&persisted_model_before,&reopened_model),
            "exactAuthoritativeContext":reopened_model==persisted_model_before,
        }),
    )?;
    ensure!(
        reopened_model == persisted_model_before,
        "target reopen changed authoritative compacted context"
    );
    let resumed = install_office_for_accepted_turn(
        &context,
        &identity,
        resumed,
        paths.clone(),
        office_providers(),
        "ctx-office-r1".into(),
    )?;
    let restored_sources =
        Sources::capture(&context, &resumed, &new_lease, &factory, &identity).await?;
    ensure!(
        restored_sources
            .binding
            .snapshot(&context, restored_sources.facts.as_ref())
            .await?
            == source_before,
        "persisted source selection drift"
    );
    ensure!(
        source_before.selection.mode == IntegrationTaskCapabilityScopeMode::InheritCurrent,
        "real selected source persisted"
    );
    let resumed = resumed.with_native_tool_authorization(restored_sources.guard.clone());
    provider.phase("reopened");
    turn(
        &resumed,
        &identity,
        "Continue the same task after target-side restore; use immutable sources",
    )
    .await?;
    let (current, after) = manifests(&context, &resumed, &paths)?;
    ensure!(after == both, "target reopen must not regenerate materials");
    let canonical_after: Vec<_> = after
        .iter()
        .map(|item| canonical(&current, item))
        .collect::<Result<_>>()?;
    ensure!(
        canonical_after == canonical_before,
        "target reopen changed canonical identities"
    );
    resumed.state.flush_history().await?;
    ensure!(
        std::fs::read(&history_path)?.starts_with(&immutable_prefix),
        "reopen rewrote original history"
    );
    let new_usage = resumed.cumulative_usage();
    ensure!(
        new_usage.total_tokens == 0
            && new_usage.input_tokens == 0
            && new_usage.output_tokens == 0
            && new_usage.cache_read_input_tokens == 0,
        "reopened Engine must keep absent usage distinct from measured tokens or cache hits"
    );
    let mut evidence = json!({"criterion":"T-WD-03/CTX-03","sourceControl":switched,
        "sourceMeaning":"None denies the configured actual local stdio MCP; InheritCurrent resolves it and permits the original owned effect. Native Office remains a builtin capability.",
        "canonicalBefore":canonical_before,"canonicalAfter":canonical_after,
        "oldHistoryBytes":immutable_prefix.len(),"oldHistorySha256":format!("{:x}",Sha256::digest(&immutable_prefix)),
        "oldTranscriptEntries":original_transcript.len(),"appendOnlyOriginalHistory":true,
        "realCompaction":{"didCompact":compacted.did_compact,"preTokens":compacted.pre_compact_tokens,
            "postTokens":compacted.post_compact_tokens,"summarySha256":digest(&compacted.summary)},
        "targetReopen":{"sameThreadId":identity.thread_id,"freshState":true,"newRealSessionLease":true,"oldLeaseInvalid":true,
            "authoritativeModelExact":true,"originalContextObservation":original_context_observation},
        "usageBoundary":{"scope":"current Engine lifetime; fixture reports no usage, zero counters are not vendor measurements",
            "oldEngine":{"input":usage_before.input_tokens,"output":usage_before.output_tokens,"total":usage_before.total_tokens},
            "newEngine":{"input":new_usage.input_tokens,"output":new_usage.output_tokens,"total":new_usage.total_tokens},
            "reportedUsage":null,"usageAvailability":"not_reported_by_fixture","localEstimatesAreVendorUsage":false,"realVendorRequests":0,"paidCalls":0}});
    capture(&provider, &mut evidence)?;
    eprintln!(
        "actual context source/material/compact/target-reopen evidence: {}",
        serde_json::to_string(&evidence)?
    );
    drop(current);
    drop(restored_sources);
    drop(resumed);
    drop(new_lease);
    Ok(())
}
