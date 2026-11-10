//! Actual approved Engine tool -> owned installed ACP/Native receiver -> controlled HTTP.
//! Source P-RUNTIME admission/policy installation is an explicit fixture, not a production PDP claim.
use super::*;
use crate::app_server::integrations::core::remote_delegations::source_budget::tests::Fixture;
use futures::StreamExt;
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::integrations::office::OfficeArtifactRef;
use kcoder_types::{ContentBlock, Message, MessagesRequest, StreamEvent};
use sha2::Digest;
use std::sync::Mutex;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[path = "cancel_tests.rs"]
mod cancel_tests;
struct ScriptedSource {
    step: AtomicUsize,
    result: Arc<Mutex<Option<Value>>>,
    cancelled: bool,
    material_failed: bool,
    material: Arc<Mutex<Option<OfficeArtifactRef>>>,
    diagnostic_native: Arc<Mutex<Option<NativeIntegrationContext>>>,
}
fn tool_result(request: &MessagesRequest, id: &str) -> String {
    for message in request.messages.iter().rev() {
        if let Message::User { content, .. } = message {
            for block in content {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } = block
                    && tool_use_id == id
                {
                    return content
                        .iter()
                        .filter_map(|part| {
                            if let ContentBlock::Text { text } = part {
                                Some(text.as_str())
                            } else {
                                None
                            }
                        })
                        .collect::<String>();
                }
            }
        }
    }
    panic!("actual prior native tool result missing")
}
impl kcoder_api::Provider for ScriptedSource {
    fn name(&self) -> &'static str {
        "scripted-owned-source-model"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let content = match step {
            0 => ContentBlock::ToolUse {
                id: "actual-native-catalog-call".into(),
                name: "RemoteCatalog".into(),
                input: json!({}),
            },
            1 => {
                let catalog: Value =
                    serde_json::from_str(&tool_result(&request, "actual-native-catalog-call"))
                        .expect("actual native catalog receipt");
                ContentBlock::ToolUse {
                    id: "actual-approved-remote-delegate".into(),
                    name: "RemoteDelegate".into(),
                    input: json!({"peerId":"actual-native-receiver","peerRevision":catalog["revision"],"prompt":"Return the exact controlled Native output once.","maximumSeconds":1800,"materials":self.material.lock().unwrap().clone().into_iter().collect::<Vec<_>>()}),
                }
            }
            2 => {
                let raw = tool_result(&request, "actual-approved-remote-delegate");
                eprintln!("actual original Native delegation result: {raw}");
                *self.result.lock().unwrap() =
                    Some(serde_json::from_str(&raw).unwrap_or_else(|_| json!({"error":raw})));
                ContentBlock::ToolUse {
                    id: "actual-original-remote-operation-read".into(),
                    name: "RemoteOperation".into(),
                    input: json!({"action":"reconcile","operationId":self.result.lock().unwrap().as_ref().unwrap()["operationId"]}),
                }
            }
            3 => {
                let original: Value = serde_json::from_str(&tool_result(
                    &request,
                    "actual-original-remote-operation-read",
                ))
                .unwrap();
                if self.material.lock().unwrap().is_some() {
                    eprintln!("actual original material receiver projection: {original}");
                    if let Some(native) = self.diagnostic_native.lock().unwrap().as_ref()
                        && let Some(operation) = original["operationId"].as_str()
                        && let Some(row) = NativeRemoteJournal::read(native, operation).unwrap()
                    {
                        eprintln!(
                            "actual original material diagnostic: {:?}",
                            row.receiver_diagnostic
                        );
                        let guard = NativeDomainGuard::observe(
                            native.profile().unwrap(),
                            native.scope(),
                            NativeDomain::RemoteDelegations,
                        )
                        .unwrap()
                        .unwrap();
                        let store = NativeRemoteDelegationStore::open_in(
                            &guard.directory(native.profile().unwrap()).unwrap(),
                            OsStr::new("data"),
                            native.scope(),
                        )
                        .unwrap()
                        .unwrap();
                        if let Some(task) = super::super::receiver_history::read_original_receiver(
                            native, &store, operation,
                        )
                        .unwrap()
                        {
                            let codes = task
                                .completion
                                .as_ref()
                                .and_then(|completion| completion.error.as_deref())
                                .unwrap_or("")
                                .split(|ch: char| {
                                    !ch.is_ascii_uppercase() && !ch.is_ascii_digit() && ch != '_'
                                })
                                .filter(|code| {
                                    code.len() <= 160
                                        && ["REMOTE_", "OFFICE_", "INTEGRATION_"]
                                            .iter()
                                            .any(|prefix| code.starts_with(prefix))
                                })
                                .collect::<Vec<_>>();
                            eprintln!("actual original receiver terminal codes: {codes:?}");
                        }
                    }
                }
                assert_eq!(original["executionTerminalConfirmed"], true, "{original}");
                assert_eq!(
                    original["receiver"]["status"],
                    if self.cancelled {
                        "interrupted"
                    } else if self.material_failed {
                        "failed"
                    } else {
                        "completed"
                    }
                );
                assert_eq!(original["ownerCleanupConfirmed"], true);
                if self.cancelled {
                    assert_eq!(original["operationPhase"], "cancelled");
                }
                ContentBlock::Text {
                    text: "Source native task complete; result validation remains partial.".into(),
                }
            }
            _ => panic!("source model fixture turn bound exceeded"),
        };
        let stop = if step < 3 { "tool_use" } else { "end_turn" };
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: content,
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some(stop.into()),
                    stop_sequence: None,
                    usage: Some(kcoder_types::Usage {
                        input_tokens: 2,
                        output_tokens: 1,
                        cache_creation_input_tokens: None,
                        cache_read_input_tokens: None,
                        total_tokens: Some(3),
                        iterations: None,
                    }),
                },
            }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}

async fn request(stream: &mut tokio::net::TcpStream) -> (String, Value) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        assert!(head.len() < 16 * 1024);
        let mut byte = [0];
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    let header = String::from_utf8(head).unwrap();
    let line = header.lines().next().unwrap().to_owned();
    let bytes = header
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    assert!(bytes <= 2 * 1024 * 1024);
    let mut body = vec![0; bytes];
    stream.read_exact(&mut body).await.unwrap();
    (
        line,
        if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}
#[tokio::test]
#[ignore = "Requires explicit already-built current Native binary; no paid model or external endpoint"]
async fn actual_normal_dispatch_native_receiver_original_budgets_and_artifact_reader_form_one_chain()
 {
    actual_chain(false, false, false).await;
}
#[tokio::test]
#[ignore = "Requires explicit current Native binary; controlled loopback only, no paid provider"]
async fn actual_ordinary_accepted_source_without_runtime_uses_explicit_outbound_budget_and_original_receiver()
 {
    actual_chain(true, false, false).await;
}
#[tokio::test]
#[ignore = "Requires explicit current Native binary; controlled loopback only, no paid provider"]
async fn actual_other_accepted_engine_cancels_only_the_original_receiver_and_preserves_unknown_model_charge()
 {
    actual_chain(true, true, false).await;
}
#[tokio::test]
#[ignore = "Requires explicit current Native binary; controlled loopback only, no paid provider"]
async fn actual_product_goal_ordinary_source_holds_and_reconciles_only_original_native_budget() {
    actual_chain(true, false, true).await;
}
#[tokio::test]
#[ignore = "Requires explicit current Native binary; controlled loopback only, no paid provider"]
async fn actual_product_goal_cancelled_receiver_retains_original_unknown_goal_tokens() {
    actual_chain(true, true, true).await;
}
#[tokio::test]
#[ignore = "Requires explicit current Native binary; controlled loopback only, no paid provider"]
async fn actual_existing_runtime_goal_uses_finite_original_source_slot_without_fixture_budget_installer()
 {
    actual_chain(false, false, true).await;
}
async fn actual_chain(ordinary_source: bool, cancel_requested: bool, with_goal: bool) {
    actual_chain_with_material(ordinary_source, cancel_requested, with_goal, false).await;
}
#[tokio::test]
#[ignore = "Requires explicit new material-capable normal Native; controlled loopback only, no paid provider"]
async fn actual_original_complete_material_reaches_native_receiver_store_and_paginated_reader_before_provider()
 {
    actual_chain_with_material(true, false, true, true).await;
}
async fn actual_chain_with_material(
    ordinary_source: bool,
    cancel_requested: bool,
    with_goal: bool,
    with_material: bool,
) {
    actual_material_case(
        ordinary_source,
        cancel_requested,
        with_goal,
        with_material,
        false,
    )
    .await;
}
#[tokio::test]
#[ignore = "Requires explicit new material-capable normal Native; controlled loopback only, no paid provider"]
async fn actual_material_parse_failure_prevents_provider_and_settles_original_receiver_slot() {
    actual_material_case(true, false, true, true, true).await;
}
async fn actual_material_case(
    ordinary_source: bool,
    cancel_requested: bool,
    with_goal: bool,
    with_material: bool,
    malformed_material: bool,
) {
    actual_office_case(
        ordinary_source,
        cancel_requested,
        with_goal,
        with_material,
        malformed_material,
        false,
    )
    .await;
}
#[tokio::test]
#[ignore = "Requires current material/Office Native and actual sealed Node resources; no paid provider"]
async fn actual_independent_receiver_native_parent_generates_docx_and_returns_complete_original_bytes()
 {
    actual_office_policy_case(
        true,
        false,
        true,
        true,
        false,
        ReceiverOfficeCase::DiscoveryAllowed,
    )
    .await;
}
#[tokio::test]
#[ignore = "Requires current material/Office Native; receiver discovery remains denied by its own Ask policy"]
async fn actual_receiver_office_missing_own_discovery_permission_preserves_original_unconfirmed_output()
 {
    actual_office_policy_case(
        true,
        false,
        true,
        true,
        false,
        ReceiverOfficeCase::DiscoveryDenied,
    )
    .await;
}
enum ReceiverOfficeCase {
    Disabled,
    DiscoveryDenied,
    DiscoveryAllowed,
}
async fn actual_office_case(
    ordinary_source: bool,
    cancel_requested: bool,
    with_goal: bool,
    with_material: bool,
    malformed_material: bool,
    produce_office: bool,
) {
    actual_office_policy_case(
        ordinary_source,
        cancel_requested,
        with_goal,
        with_material,
        malformed_material,
        if produce_office {
            ReceiverOfficeCase::DiscoveryDenied
        } else {
            ReceiverOfficeCase::Disabled
        },
    )
    .await;
}
async fn actual_office_policy_case(
    ordinary_source: bool,
    cancel_requested: bool,
    with_goal: bool,
    with_material: bool,
    malformed_material: bool,
    office_case: ReceiverOfficeCase,
) {
    let produce_office = !matches!(office_case, ReceiverOfficeCase::Disabled);
    let receiver_discovery_allowed = matches!(office_case, ReceiverOfficeCase::DiscoveryAllowed);
    let binary = PathBuf::from(
        std::env::var_os("KCODER_REMOTE_TEST_NATIVE")
            .expect("explicit actual Native installation required"),
    );
    assert!(binary.is_absolute() && binary.is_file());
    let result_slot = Arc::new(Mutex::new(None));
    let material = Arc::new(Mutex::new(None));
    let diagnostic_native = Arc::new(Mutex::new(None));
    let mut f = Fixture::new_with_provider(Arc::new(ScriptedSource {
        step: AtomicUsize::new(0),
        result: result_slot.clone(),
        cancelled: cancel_requested,
        material_failed: malformed_material,
        material: material.clone(),
        diagnostic_native: diagnostic_native.clone(),
    }));
    *diagnostic_native.lock().unwrap() = Some(f.native.recapture_for_owned_service().unwrap());
    let material_text = format!(
        "MATERIAL_ORIGINAL_START\n{}MATERIAL_ORIGINAL_END\n",
        "complete original material data row\n".repeat(2000)
    );
    let material_sha = format!("{:x}", sha2::Sha256::digest(material_text.as_bytes()));
    if with_material {
        let (_, store) = NativeDomainGuard::initialize(
            f.native.profile().unwrap(),
            f.native.scope(),
            NativeDomain::Office,
            "actual-original-material-accept",
            |directory| {
                kcoder_state::integrations::office::OfficeStore::create_in(
                    directory,
                    OsStr::new("data"),
                    IntegrationOwner::from(f.native.scope()),
                )
            },
        )
        .unwrap();
        store
            .begin_input_attempt(
                "actual-original-material-accept",
                "actual-original-material",
                kcoder_state::integrations::office::OfficeInputMetadata {
                    filename: if malformed_material {
                        "invalid-original.docx"
                    } else {
                        "original-material.txt"
                    }
                    .into(),
                    media_type: "text/plain".into(),
                    expected_bytes: material_text.len() as u64,
                    expected_sha256: material_sha.clone(),
                },
            )
            .unwrap();
        store
            .complete_stored_input(
                "actual-original-material-accept",
                "actual-original-material",
                &mut std::io::Cursor::new(material_text.as_bytes()),
                || true,
            )
            .unwrap();
        *material.lock().unwrap() = Some(OfficeArtifactRef {
            id: "actual-original-material".into(),
            revision: 1,
        });
    }
    let parent_path = f.native.profile_path().unwrap().parent().unwrap();
    let parent = PrivateDirectory::open_existing(parent_path).unwrap();
    parent
        .create_private_child(OsStr::new("actual-receiver-profile"))
        .unwrap();
    let receiver_profile = parent_path.join("actual-receiver-profile");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let posts = Arc::new(AtomicUsize::new(0));
    let heads = Arc::new(AtomicUsize::new(0));
    let discovery_denied = Arc::new(AtomicBool::new(false));
    let observed_discovery_denied = discovery_denied.clone();
    let (post_count, head_count) = (posts.clone(), heads.clone());
    let provider_started = Arc::new(tokio::sync::Notify::new());
    let started = provider_started.clone();
    let provider = tokio::spawn(async move {
        for _ in 0..8 {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let (line, body) = request(&mut stream).await;
            if line.starts_with("HEAD ") {
                head_count.fetch_add(1, Ordering::SeqCst);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                continue;
            }
            assert!(
                line.starts_with("POST /v1/chat/completions "),
                "unexpected owned request {line}"
            );
            post_count.fetch_add(1, Ordering::SeqCst);
            if cancel_requested {
                started.notify_one();
                let mut eof = [0u8; 1];
                let stopped =
                    tokio::time::timeout(std::time::Duration::from_secs(30), stream.read(&mut eof))
                        .await
                        .unwrap();
                assert!(
                    stopped.is_err() || stopped.unwrap() == 0,
                    "owned original request must close after cancellation"
                );
                return body;
            }
            let office_step = post_count.load(Ordering::SeqCst);
            if produce_office {
                let attached = body["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| row["function"]["name"].as_str())
                    .collect::<Vec<_>>();
                eprintln!(
                    "actual owned receiver advertised tools: step={office_step} {attached:?}"
                );
                for message in body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|row| row["role"] == "tool")
                {
                    let text = message["content"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| message["content"].to_string());
                    if message["tool_call_id"] == "receiver-office-1"
                        && text.to_lowercase().contains("permission denied")
                    {
                        observed_discovery_denied.store(true, Ordering::SeqCst);
                    }
                    let codes = text
                        .split(|ch: char| {
                            !ch.is_ascii_uppercase() && !ch.is_ascii_digit() && ch != '_'
                        })
                        .filter(|code| {
                            code.len() <= 160
                                && ["REMOTE_", "OFFICE_", "TOOL_"]
                                    .iter()
                                    .any(|prefix| code.starts_with(prefix))
                        })
                        .collect::<Vec<_>>();
                    eprintln!(
                        "actual owned receiver tool observation: step={office_step} call={} codes={codes:?} artifactField={} discoveredOffice={}",
                        message["tool_call_id"],
                        text.contains("artifact"),
                        text.contains("OfficeDocument")
                    );
                    let markers = [
                        "Unknown tool",
                        "not found",
                        "unavailable",
                        "not discovered",
                        "permission denied",
                        "denied",
                        "schema",
                        "Invalid",
                        "too large",
                        "disabled",
                    ]
                    .into_iter()
                    .filter(|marker| text.to_lowercase().contains(&marker.to_lowercase()))
                    .collect::<Vec<_>>();
                    eprintln!("actual owned receiver controlled tool-result markers: {markers:?}");
                }
            }
            let final_delta = if produce_office && office_step < 3 {
                let input = if office_step == 1 {
                    json!({"query":"OfficeDocument","limit":1})
                } else {
                    let material = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|row| row["content"].as_str())
                        .filter_map(|text| {
                            text.split_once('\n')
                                .and_then(|(_, text)| serde_json::from_str::<Value>(text).ok())
                        })
                        .find(|row| row["kind"] == "original_remote_material_data")
                        .unwrap();
                    let input = &material["materials"][0]["receiverInput"];
                    let complete_text = material["materials"][0]["chunks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| row["text"].as_str().unwrap())
                        .collect::<String>();
                    let lines = complete_text.split_inclusive('\n').collect::<Vec<_>>();
                    let paragraphs = lines
                        .chunks(200)
                        .map(|part| json!({"text":part.concat()}))
                        .collect::<Vec<_>>();
                    json!({"tool_name":"OfficeDocument","arguments":{"specification":{"schemaVersion":1,"kind":"docx",
                        "title":"Original received native material","paragraphs":paragraphs},
                        "sourceRefs":[{"kind":"input","id":input["id"],"revision":"1"}]}})
                };
                json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("receiver-office-{office_step}"),"type":"function",
                    "function":{"name":if office_step==1{"tool_search"}else{"tool_execute"},"arguments":serde_json::to_string(&input).unwrap()}}]})
            } else {
                json!({"role":"assistant","content":"Actual metered Native receiver output."})
            };
            let finish_reason = if produce_office && office_step < 3 {
                "tool_calls"
            } else {
                "stop"
            };
            let chunks = format!(
                "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"id":"actual-metered-native","object":"chat.completion.chunk","choices":[{"index":0,"delta":final_delta,"finish_reason":null}]}),
                json!({"id":"actual-metered-native","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish_reason}]}),
                json!({"id":"actual-metered-native","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})
            );
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{chunks}",chunks.len()).as_bytes()).await.unwrap();
            if produce_office && office_step < 3 {
                continue;
            }
            return body;
        }
        panic!("owned metadata probe limit exceeded")
    });
    let mut receiver_settings = json!({"active_provider":"OwnedReceiver","model":"actual-owned-model","max_tokens":64,"max_retries":0,
        "tools":{"profile":"none"},"session_memory":{"enabled":false},"mcp_servers":[],"plugins":{"runtime":{"enabled":false}},"skills":{"auto_curator_enabled":false,"auto_skill_review_enabled":false},
        "providers":{"OwnedReceiver":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":endpoint,"default_model":"actual-owned-model","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":8192,"discover_models":false,"no_proxy":true}},
        "integrations":{"remotes":{"receiver":{"enabled":true,"allowedSenderAccounts":[f.native.scope().account_id],"maximumTotalTokens":100000,"maximumModelCalls":1,"maximumDurationSeconds":1800,"acceptMaterials":with_material,"maximumMaterialBytes":if with_material {33554432} else {0}}}}});
    if produce_office {
        let startup: Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var_os("KCODER_REMOTE_TEST_OFFICE_STARTUP")
                    .expect("actual sealed Office/Node observation"),
            )
            .unwrap(),
        )
        .unwrap();
        receiver_settings["tools"]["profile"] = json!("core");
        receiver_settings["permission_mode"] = json!("ask");
        receiver_settings["permission_rules"] = json!([{"tool":"OfficeDocument","action":"allow"}]);
        if receiver_discovery_allowed {
            // This is the receiving owner's explicit bounded profile policy.
            // Source permission, ACP metadata and tool_execute never grant it.
            receiver_settings["permission_rules"]
                .as_array_mut()
                .unwrap()
                .push(json!({"tool":"tool_search","action":"allow"}));
        }
        receiver_settings["integrations"]["office"] =
            json!({"enabled":true,"allowedFormats":["docx"]});
        receiver_settings["integrations"]["remotes"]["receiver"]["maximumTotalTokens"] =
            json!(400000);
        receiver_settings["integrations"]["remotes"]["receiver"]["maximumModelCalls"] = json!(3);
        receiver_settings["integrations"]["remotes"]["receiver"]["office"] = json!({"enabled":true,"allowedFormats":["docx"],
            "allowedTools":["OfficeDocument","tool_execute","tool_search"],"startupConfiguration":startup});
    }
    PrivateDirectory::open_existing(&receiver_profile)
        .unwrap()
        .atomic_replace(
            OsStr::new("settings.json"),
            &serde_json::to_vec(&receiver_settings).unwrap(),
        )
        .unwrap();
    f.native.profile().unwrap().atomic_replace(OsStr::new("settings.json"),&serde_json::to_vec(&json!({"integrations":{"office":{"enabled":true},"remotes":{"enabled":true,"outbound":{"enabled":ordinary_source || with_goal,"maximumTotalTokens":if produce_office{400000}else{200000},"maximumModelCalls":if produce_office{3}else{1},"maximumDurationSeconds":1800},"nativeAcpPeers":[{"id":"actual-native-receiver","enabled":true,"profileDirectory":receiver_profile,"maximumDurationSeconds":1800}]}}})).unwrap()).unwrap();
    f.engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = true;
    f.engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Ask;
    let ledger = if ordinary_source {
        None
    } else if with_goal {
        f.accept_runtime_with_policy(super::super::super::runtime_driver::RuntimeExternalSend::Ask);
        None
    } else {
        f.accept_runtime_with_policy(super::super::super::runtime_driver::RuntimeExternalSend::Ask);
        Some(f.install_original_budget_with_tokens(200000))
    };
    let goal_id = with_goal.then(|| {
        f.engine
            .state
            .set_goal(
                "Explicit original product Goal for bounded Native delegation",
                Some(1_000_000),
            )
            .goal_id
    });
    let attempt = f.attempt.clone();
    let controller = if cancel_requested {
        let operation = format!(
            "remote-{}",
            super::super::launch::digest(&(
                IntegrationOwner::from(f.native.scope()),
                &attempt,
                "actual-approved-remote-delegate"
            ))
            .unwrap()
        );
        Some(cancel_tests::start(
            f.native.recapture_for_owned_service().unwrap(),
            f.engine.state.cwd(),
            operation,
            provider_started,
        ))
    } else {
        None
    };
    let result=f.engine.state.history_attempt_scope(attempt.clone()).unwrap().run(async{
        let installed=install_with_native_selection(&f.native,&attempt,f.engine.clone(),NativeExecutableSelection::Installed(binary)).unwrap();
        installed.state.add_message(Message::user_text("Delegate the explicit owned task to the configured Native receiver once."));
        let events=installed.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        let result=result_slot.lock().unwrap().clone().unwrap_or_else(||json!({"error":format!("Source stream did not return a native delegation result: {events:?}")}));
        assert!(result.get("error").is_none(),"{result}");
        if result["state"]!="native_receiver_observed"{
            if let Some(operation)=result["operationId"].as_str() && let Some(original)=NativeRemoteJournal::read(&f.native,operation).unwrap(){eprintln!("actual native receiver diagnostic: {:?}",original.receiver_diagnostic);}
            eprintln!("owned provider facts: POST={} HEAD={}",posts.load(Ordering::SeqCst),heads.load(Ordering::SeqCst));
            let mut pending=vec![receiver_profile.clone()];let mut visited=0;
            while let Some(directory)=pending.pop(){visited+=1;if visited>512{break}
                for entry in std::fs::read_dir(&directory).unwrap(){let entry=entry.unwrap();let kind=entry.file_type().unwrap();
                    if kind.is_dir(){pending.push(entry.path())}else if directory.file_name()==Some(OsStr::new("turn-attempts")) && let Ok(record)=serde_json::from_slice::<kcoder_state::turn_attempt_store::TurnAttemptRecord>(&std::fs::read(entry.path()).unwrap()){
                            eprintln!("owned actual receiver attempt: {:?} {:?}",record.identity,record.completion.map(|completion|completion.error));
                    }
                }
            }
        }
        if malformed_material {
            assert_eq!(result["state"],"outcome_unknown");
            let operation=result["operationId"].as_str().unwrap();
            let original=NativeRemoteJournal::read(&f.native,operation).unwrap().unwrap();
            assert!(original.owner_cleanup.as_ref().is_some_and(|cleanup|cleanup.confirmed));
            assert_eq!(posts.load(Ordering::SeqCst),0,"Reader parse failure must precede all Provider calls");
            assert!(!original.stages.contains_key(&NativeRemoteStage::OutputTransfer));
            let reconciled=super::super::management::manage_original(&f.native,&kcoder_tools::integrations::remotes::RemoteOperationInput{
                action:kcoder_tools::integrations::remotes::RemoteOperationAction::Reconcile,operation_id:operation.into(),expected_revision:None,
            }).unwrap();
            assert_eq!(reconciled["receiver"]["status"],"failed");
            assert_eq!(reconciled["executionTerminalConfirmed"],true);
            let source_guard=NativeDomainGuard::observe(f.native.profile().unwrap(),f.native.scope(),NativeDomain::RemoteDelegations).unwrap().unwrap();
            let source_store=NativeRemoteDelegationStore::open_in(&source_guard.directory(f.native.profile().unwrap()).unwrap(),OsStr::new("data"),f.native.scope()).unwrap().unwrap();
            let launch=source_store.read_native_launch(operation).unwrap().unwrap();
            let launch:super::super::launch::NativeRemoteLaunchRecord=serde_json::from_slice(launch.bytes()).unwrap();
            let mut account=launch.receiver_scope;account.workspace_id=IntegrationNullable::Null;
            let receiver_directory=PrivateDirectory::open_existing(&receiver_profile).unwrap();
            let receiver_guard=NativeDomainGuard::observe(&receiver_directory,&account,NativeDomain::Budgets).unwrap().unwrap();
            let receiver_ledger=NativeBudgetStore::open_in(&receiver_guard.directory(&receiver_directory).unwrap(),OsStr::new("ledger"),&account).unwrap().unwrap();
            let accepted=original.receiver.as_ref().unwrap();
            let slot=format!("remote-receiver-slot-{}",super::super::launch::digest(&(operation,&accepted.identity)).unwrap());
            let slot=receiver_ledger.read_reservation(&slot).unwrap().unwrap();
            assert!(slot.execution_confirmed_terminal,"material failure must keep original receiver owner until actual turn terminal");
            assert_eq!(slot.charged.tokens,0);
            eprintln!("actual material Reader failure: receiverFailed=true ProviderPOST=0 originalReceiverSlotTerminal=true originalSlotTokens=0 cleanupConfirmed=true");
            f.finish();
            return result;
        }
        if cancel_requested {
            assert_eq!(result["state"],"outcome_unknown");
            let operation=result["operationId"].as_str().unwrap();
            let original=NativeRemoteJournal::read(&f.native,operation).unwrap().unwrap();
            assert!(original.owner_cleanup.as_ref().is_some_and(|cleanup|cleanup.confirmed));
            let root=super::super::ordinary_source::root_operation(f.native.scope(),&attempt).unwrap();
            let ledger=super::super::super::budget_host::NativeBudgetService::load(&f.native).unwrap().unwrap().accounting_store();
            let policies=ledger.current_applicable_policies(&NativeBudgetPrincipal::from_native_facts(f.native.scope().account_id.clone(),None,f.native.scope().workspace_id.as_ref().cloned(),None).unwrap(),&root,super::super::launch::now().unwrap()).unwrap();
            let actual=ledger.observe_policy(&policies[0]).unwrap().unwrap();
            assert_eq!(actual.charged.model_calls,1);assert!(actual.charged.tokens>0);assert!(actual.unknown_cost_reservations>0);
            assert!(!original.stages.contains_key(&NativeRemoteStage::OutputTransfer));
            f.finish();
            return result;
        }
        if produce_office && !receiver_discovery_allowed {
            assert!(discovery_denied.load(Ordering::SeqCst), "the receiver's actual tool_search must be denied by its own policy");
            assert_eq!(result["state"],"outcome_unknown");
            assert_eq!(result["code"],"REMOTE_NATIVE_OUTPUT_REQUIRES_ORIGINAL_READ");
            assert_eq!(result["businessCompleted"],false);
            let original=NativeRemoteJournal::read(&f.native,result["operationId"].as_str().unwrap()).unwrap().unwrap();
            assert!(original.owner_cleanup.as_ref().is_some_and(|cleanup|cleanup.confirmed));
            assert!(!original.stages.contains_key(&NativeRemoteStage::OutputTransfer));
            eprintln!("actual missing receiver discovery permission: originalOperationPreserved=true noOutputTransfer=true businessCompleted=false cleanupConfirmed=true");
            f.finish();
            return result;
        }
        assert_eq!(result["state"],"native_receiver_observed");assert_eq!(result["ownerCleanupConfirmed"],true);
        if produce_office { assert!(!discovery_denied.load(Ordering::SeqCst)); }
        assert_eq!(result["businessCompleted"],false);assert_eq!(result["verification"],"partial");
        assert_eq!(result["reader"]["state"],"received");
        let operation=result["operationId"].as_str().unwrap();let original=NativeRemoteJournal::read(&f.native,operation).unwrap().unwrap();
        let receiver=original.receiver.clone().unwrap();assert!(!receiver.identity.thread_id.is_empty());
        let root = if ordinary_source { super::super::ordinary_source::root_operation(f.native.scope(),&attempt).unwrap() } else { "actual-original-runtime-task".into() };
        let ledger=ledger.clone().unwrap_or_else(||super::super::super::budget_host::NativeBudgetService::load(&f.native).unwrap().unwrap().accounting_store());
        if ordinary_source { assert!(super::super::super::runtime_driver::NativeRuntimeDriver::load(&f.native).unwrap().is_none()); }
        let source_profile=ledger.current_applicable_policies(&NativeBudgetPrincipal::from_native_facts(f.native.scope().account_id.clone(),None,f.native.scope().workspace_id.as_ref().cloned(),None).unwrap(),&root,super::super::launch::now().unwrap()).unwrap();
        assert_eq!(source_profile.len(),1);let budget=ledger.observe_policy(&source_profile[0]).unwrap().unwrap();
        assert_eq!(budget.charged.model_calls,if produce_office{3}else{1});assert_eq!(budget.charged.tokens,if produce_office{15}else{5});
        assert!(original.safe_receipts[&NativeRemoteStage::OutputTransfer]["sha256"].as_str().is_some());
        let rechecked=super::super::management::manage_original(&f.native,&kcoder_tools::integrations::remotes::RemoteOperationInput{
            action:kcoder_tools::integrations::remotes::RemoteOperationAction::Reconcile,operation_id:operation.into(),expected_revision:None,
        }).unwrap();
        assert_eq!(rechecked["receiver"]["status"],"completed");
        assert_eq!(rechecked["executionTerminalConfirmed"],true);
        let no_rewrite=super::super::management::manage_original(&f.native,&kcoder_tools::integrations::remotes::RemoteOperationInput{
            action:kcoder_tools::integrations::remotes::RemoteOperationAction::Cancel,operation_id:operation.into(),expected_revision:Some(0),
        }).unwrap();
        assert_eq!(no_rewrite["cancellationState"],"already_terminal");
        assert_eq!(no_rewrite["operationRevision"],rechecked["operationRevision"]);
        assert_eq!(no_rewrite["receiver"]["status"],"completed");
        let owner=Arc::new(());
        let controls=super::super::control::NativeRemoteOperationControl::capture(&f.native,&installed,Arc::downgrade(&owner),CancellationToken::new()).unwrap();
        let ui=controls.run(&RemoteOperationControlParams{request_id:"actual-native-ui-read".into(),scope:f.native.scope().clone(),operation_id:operation.into(),expected_revision:None},false).unwrap();
        let view=ui.snapshot.unwrap();
        assert_eq!(view.receiver.status,RemoteOperationReceiverStatus::Completed);
        assert_eq!(view.cleanup,RemoteOperationCleanupStatus::Confirmed);
        assert_eq!(view.artifact.unwrap().sha256,result["artifact"]["sha256"]);
        assert!(!view.business_completed);
        let newer=NativeIntegrationContext::capture_existing(f.native.profile_path().unwrap(),&f.engine.state.cwd(),"actual-ui-current-model","next-user-model-revision").unwrap();
        let current=super::super::management::manage_original(&newer,&kcoder_tools::integrations::remotes::RemoteOperationInput{action:kcoder_tools::integrations::remotes::RemoteOperationAction::Read,operation_id:operation.into(),expected_revision:None}).unwrap();
        assert_eq!(current["receiver"]["status"],"completed");

        assert!(!rechecked.to_string().contains(receiver_profile.to_str().unwrap()));

        use crate::app_server::integrations::office::{native_assets::NativeOfficeFileAssets,native_host::NativeOfficeAssets};
        use kcoder_types::integrations::office::{OfficeArtifactRef,OfficeExportReceipt};
        use base64::Engine;
        let guard=NativeDomainGuard::observe(f.native.profile().unwrap(),f.native.scope(),NativeDomain::Office).unwrap().unwrap();
        let store=kcoder_state::integrations::office::OfficeStore::open_in(&guard.directory(f.native.profile().unwrap()).unwrap(),OsStr::new("data"),IntegrationOwner::from(f.native.scope())).unwrap().unwrap();
        let reference=OfficeArtifactRef{id:result["artifact"]["id"].as_str().unwrap().into(),revision:result["artifact"]["revision"].as_u64().unwrap()};
        let manifest=store.read_artifact(&reference).unwrap().unwrap();
        let (bytes,total)=store.read_artifact_chunk(&reference,0,512*1024).unwrap();assert_eq!(total,bytes.len() as u64);
        if produce_office { assert_eq!(manifest.format,kcoder_types::integrations::office::OfficeFileFormat::Docx);
            assert!(bytes.starts_with(b"PK"));assert!(manifest.source_refs.iter().any(|row|row.kind=="native_remote_artifact"));
            eprintln!("actual original receiver DOCX return: bytes={} sha256={} originalNativeArtifact=true",bytes.len(),manifest.sha256); }

        let assets=NativeOfficeFileAssets::capture(&f.native,&installed,Arc::new(Default::default()),None).unwrap();
        let request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,request_id:"actual-explicit-remote-output-export".into(),scope:f.native.scope().clone(),operation_id:Some("actual-original-output-export".into()),expected_revision:None,timeout_ms:1000,cancellation_ref:None,payload:Default::default()};
        let exported=assets.prepare_export(&f.native,&request,&manifest,bytes.clone(),&CancellationToken::new()).await.unwrap();
        let receipt:OfficeExportReceipt=serde_json::from_value(exported).unwrap();
        let page=assets.read_attachment_chunk(&f.native,&kcoder_app_protocol::AttachmentReadChunkParams{thread_id:attempt.thread_id.clone(),path:NativeOfficeFileAssets::export_locator(&receipt),offset:0,length:192*1024},&CancellationToken::new()).await.unwrap();
        assert!(page.eof);assert_eq!(page.total_size,total);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(page.content_base64).unwrap(),bytes);
        if produce_office && let Some(evidence_root)=std::env::var_os("KCODER_REMOTE_TEST_EVIDENCE_DIRECTORY") {
            let root=PrivateDirectory::open_existing(&PathBuf::from(evidence_root)).unwrap();
            root.verify_private_directory().unwrap();
            let evidence=root.create_private_child(OsStr::new(operation)).unwrap();
            evidence.atomic_replace(OsStr::new("original-source-received.docx"),&bytes).unwrap();
            evidence.atomic_replace(OsStr::new("source-manifest.json"),&serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
            evidence.atomic_replace(OsStr::new("accepted-source-material.txt"),material_text.as_bytes()).unwrap();
            eprintln!("actual owned DOCX evidence retained: originalOperation={operation} fullBytes={} sha256={}",bytes.len(),manifest.sha256);
        }
        f.finish();

        result
    }).await;
    if ordinary_source || with_goal {
        let service = super::super::super::budget_host::NativeBudgetService::load(&f.native)
            .unwrap()
            .unwrap();
        let root = if ordinary_source {
            super::super::ordinary_source::root_operation(f.native.scope(), &attempt).unwrap()
        } else {
            super::super::super::runtime_driver::NativeRuntimeDriver::load(&f.native)
                .unwrap()
                .unwrap()
                .operation_for_reference(
                    &f.native,
                    &IntegrationRuntimeReadTaskParams {
                        thread_id: Some(attempt.thread_id.clone()),
                        turn_id: Some(attempt.turn_id.clone()),
                        task_id: None,
                    },
                )
                .unwrap()
        };
        let slot = service
            .accounting_store()
            .read_reservation(&format!(
                "remote-source-slot-{}",
                super::super::launch::digest(&root).unwrap()
            ))
            .unwrap()
            .unwrap();
        assert!(
            slot.execution_confirmed_terminal,
            "actual Source task completion must release its original slot"
        );
    }
    if let Some(goal_id) = goal_id {
        let actual = f.engine.state.goal().unwrap();
        assert_eq!(actual.goal_id, goal_id);
        let public = actual.public_native_budget_projection().unwrap();
        let remote_charge = public["native_budget"]["charged_tokens"].as_u64().unwrap();
        assert_eq!(
            actual.tokens_used,
            12 + remote_charge,
            "the same original product Goal combines the four real Source usage snapshots with the original receiver charge"
        );
        if cancel_requested {
            assert!(
                remote_charge > 0,
                "unknown dispatched receiver usage must remain charged"
            );
            assert_eq!(public["native_budget"]["unknown_tokens"], remote_charge);
        } else {
            assert_eq!(
                remote_charge,
                if malformed_material {
                    0
                } else if produce_office {
                    15
                } else {
                    5
                }
            );
            assert_eq!(public["native_budget"]["held_tokens"], 0);
            assert_eq!(public["native_budget"]["unknown_tokens"], 0);
            assert!(
                actual
                    .events
                    .iter()
                    .any(|event| event.kind == kcoder_state::GoalEventKind::NativeBudgetReconciled)
            );
        }
        eprintln!(
            "actual product Goal source budget: tokensUsed={} SourceKnown=12 remote={}",
            actual.tokens_used, public["native_budget"]
        );
    }
    if malformed_material {
        provider.abort();
        assert!(provider.await.unwrap_err().is_cancelled());
    } else if result["state"] == "native_receiver_observed"
        || cancel_requested
        || (produce_office && !receiver_discovery_allowed)
    {
        let body = tokio::time::timeout(std::time::Duration::from_secs(5), provider)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body["model"], "actual-owned-model");
        if with_material {
            let encoded = serde_json::to_string(&body["messages"]).unwrap();
            assert!(
                encoded.contains("MATERIAL_ORIGINAL_START")
                    && encoded.contains("MATERIAL_ORIGINAL_END")
            );
            assert!(encoded.contains(&material_sha));
            assert!(
                encoded.contains("readerPagesComplete") && encoded.contains("byteTransferComplete")
            );
            let data = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|message| message["content"].as_str())
                .filter_map(|text| {
                    text.split_once('\n')
                        .and_then(|(_, json)| serde_json::from_str::<Value>(json).ok())
                })
                .find(|value| value["kind"] == "original_remote_material_data")
                .expect("actual material data in actual Provider input");
            let chunks = data["materials"][0]["chunks"].as_array().unwrap();
            assert!(
                chunks.len() > 4,
                "the actual Reader must consume more than one page"
            );
            let complete_text = chunks
                .iter()
                .map(|chunk| chunk["text"].as_str().unwrap())
                .collect::<String>();
            assert_eq!(complete_text, material_text);

            eprintln!(
                "actual original material received before Provider: bytes={} sha256={} completeReader=true",
                material_text.len(),
                material_sha
            );
        }
        assert_eq!(
            posts.load(Ordering::SeqCst),
            if produce_office { 3 } else { 1 }
        );
        assert!(heads.load(Ordering::SeqCst) <= 3);
    }
    if let Some(controller) = controller {
        controller.await.unwrap();
    }
    f.close().await;
}
