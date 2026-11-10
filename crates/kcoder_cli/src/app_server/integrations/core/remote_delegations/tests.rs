//! Real private Native profile/Accepted ledger bindings. No model or child is started here.
use super::authority::AcceptedRemoteAuthority;
use super::*;
use crate::app_server::thread_runtime::test_support::test_runtime;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::{
    TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_tools::ToolContext;
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use serde_json::json;
use sha2::Digest;
use std::path::PathBuf;

struct Fixture {
    _temp: tempfile::TempDir,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    attempt: TurnAttemptIdentity,
    receiver: PathBuf,
    workspace: PathBuf,
    native_program: Option<PathBuf>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        for name in ["sender", "receiver", "workspace", "receiver-workspace"] {
            parent.create_private_child(OsStr::new(name)).unwrap();
        }
        let sender = temp.path().join("sender");
        let receiver = temp.path().join("receiver");
        let workspace = temp.path().join("receiver-workspace");
        let native = NativeIntegrationContext::capture(
            &sender,
            &temp.path().join("workspace"),
            "owned-remote",
            "config-r1",
        )
        .unwrap();
        native.profile().unwrap().atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&json!({
            "integrations":{"remotes":{"enabled":true,"nativeAcpPeers":[{
                "id":"explicit-peer","title":"Owned peer","enabled":true,"profileDirectory":receiver,"maximumDurationSeconds":1800
            }]}}
        })).unwrap()).unwrap();
        PrivateDirectory::open_existing(&receiver)
            .unwrap()
            .atomic_replace(
                OsStr::new("settings.json"),
                &serde_json::to_vec(&json!({"tools":{"profile":"none"},"session_memory":{"enabled":false},"mcp_servers":[],"plugins":{"runtime":{"enabled":false}},"skills":{"auto_curator_enabled":false,"auto_skill_review_enabled":false},
                    "integrations":{"remotes":{"receiver":{"enabled":true,"allowedSenderAccounts":[native.scope().account_id],"maximumDurationSeconds":1800}}}})).unwrap(),
            )
            .unwrap();
        let engine = test_runtime(
            "actual-remote-sender",
            &temp.path().join("workspace/history.jsonl"),
        )
        .engine()
        .with_settings_persistence_path(sender.join("settings.json"));
        let attempt = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "actual-accepted-turn".into(),
            attempt_id: "actual-accepted-attempt".into(),
        };
        TurnAttemptStore::open(
            &engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )
        .unwrap()
        .begin(TurnAttemptRecord {
            version: 1,
            identity: attempt.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
            client_presentation: None,
        })
        .unwrap();
        Self {
            _temp: temp,
            native,
            engine,
            attempt,
            receiver,
            workspace,
            native_program: None,
        }
    }
    fn caller(&self) -> ToolContext {
        ToolContext::new(self.engine.state.clone()).with_tool_call_id("actual-original-native-call")
    }
    fn authority(&self, caller: &ToolContext) -> Result<AcceptedRemoteAuthority> {
        let registry =
            registry::observe(&self.native, &self.engine)?.context("registry missing")?;
        let registry = match &self.native_program {
            Some(program) => registry.with_installed_test_program(program.clone()),
            None => registry,
        };
        let input = kcoder_tools::integrations::remotes::RemoteDelegateInput {
            peer_id: "explicit-peer".into(),
            peer_revision: registry.revision().into(),
            prompt: "Frozen material, not authority".into(),
            materials: Vec::new(),
            maximum_seconds: 1800,
        };
        AcceptedRemoteAuthority::bind_current_call(
            &self.native,
            &self.engine,
            &self.attempt,
            caller,
            registry,
            &self.workspace,
            input,
        )
    }
    fn finish(&self) {
        TurnAttemptStore::open_existing(
            &self.engine.session_storage_dir_for(&self.attempt.thread_id),
            &self.attempt.thread_id,
        )
        .unwrap()
        .unwrap()
        .finish(
            &self.attempt,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: 2,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: None,
            },
        )
        .unwrap();
    }
}

#[tokio::test]
async fn unconfigured_or_disabled_remote_tools_do_not_require_an_opted_in_profile_path() {
    let root = kcoder_config::create_private_temp_dir("remote-optional-profile").unwrap();
    let parent = PrivateDirectory::open_existing(root.path()).unwrap();
    let profile = parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let native = NativeIntegrationContext::capture(
        &root.path().join("profile"),
        &root.path().join("workspace"),
        "optional-native-remote",
        "original-model-config",
    )
    .unwrap();
    let engine = test_runtime(
        "optional-native-remote",
        &root.path().join("workspace/history.jsonl"),
    )
    .engine();
    assert!(engine.settings_persistence_path().is_none());
    assert!(registry::observe(&native, &engine).unwrap().is_none());
    profile
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"integrations":{"remotes":{"enabled":false}}}"#,
        )
        .unwrap();
    assert!(registry::observe(&native, &engine).unwrap().is_none());
    profile
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"integrations":{"remotes":{"enabled":true}}}"#,
        )
        .unwrap();
    let error = registry::observe(&native, &engine).err().unwrap();
    assert_eq!(error.to_string(), "REMOTE_PROFILE_SETTINGS_UNAVAILABLE");
    profile
        .atomic_replace(
            OsStr::new("settings.json"),
            br#"{"integrations":{"remotes":{"enabled":"invalid"}}}"#,
        )
        .unwrap();
    assert!(registry::observe(&native, &engine).is_err());
}

#[tokio::test]
async fn current_accepted_scope_binds_actual_state_call_receiver_and_installed_runner() {
    let f = Fixture::new();
    let caller = f.caller();
    f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
        let authority=f.authority(&caller).unwrap();
        let runner=authority.runner().unwrap();
        assert_eq!(authority.original_call_id(),"actual-original-native-call");
        assert_eq!(authority.peer_id(),"explicit-peer");
        assert_eq!(runner.executable(),std::env::current_exe().unwrap());
        assert_eq!(runner.arguments(), ["acp","--tool-profile","none","--max-retries","0"].map(std::ffi::OsString::from));
        assert_eq!(runner.environment().len(),2);
        assert_eq!(runner.environment()[std::ffi::OsStr::new("KCODER_CONFIG_DIR")],f.receiver);
        assert_eq!(authority.recipient_identity()["programSha256"].as_str().unwrap().len(),64);
        authority.verify_runner(&f.native,&runner).unwrap();
        for (arguments, environment) in [
            (vec!["acp".into(),"--tool-profile".into(),"full".into()],runner.environment().clone()),
            (runner.arguments().to_vec(),std::collections::BTreeMap::from([(std::ffi::OsString::from("KCODER_MODEL"),std::ffi::OsString::from("unapproved-model"))])),
        ] {
            let changed=InstalledOutboundRunner::from_native_installation(runner.executable().into(),arguments,environment,
                runner.workspace().into(),runner.owner_executable().into(),"kcoder".into(),kcoder_cli_commands::build_identity::version().into()).unwrap();
            assert!(authority.verify_runner(&f.native,&changed).is_err());
        }
        authority.observe_receipt(OutboundEffect::Session,&json!({"sessionId":"same-original-session"})).unwrap();
        authority.check_frozen_intent(OutboundEffect::Prompt,&json!({"sessionId":"same-original-session","prompt":[{"type":"text","text":"Frozen material, not authority"}]})).unwrap();
        assert!(authority.check_frozen_intent(OutboundEffect::Prompt,&json!({"sessionId":"forged-session","prompt":[{"type":"text","text":"Frozen material, not authority"}]})).is_err());
        assert!(authority.observe_receipt(OutboundEffect::Session,&json!({"sessionId":"new-session"})).is_err());
    }).await;
}

#[tokio::test]
async fn stored_accepted_record_without_current_native_scope_cannot_grant_delegation() {
    let f = Fixture::new();
    assert!(f.authority(&f.caller()).is_err());
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let authority = f.authority(&f.caller()).unwrap();
            f.finish();
            assert!(authority.runner().is_err());
            assert!(f.authority(&f.caller()).is_err());
        })
        .await;
}

#[tokio::test]
async fn foreign_state_cancelled_missing_call_and_changed_profiles_reject() {
    let f = Fixture::new();
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let impostor = kcoder_state::AppState::new(&f.workspace);
            assert!(
                f.authority(
                    &ToolContext::new(impostor).with_tool_call_id("actual-original-native-call")
                )
                .is_err()
            );
            assert!(
                f.authority(&ToolContext::new(f.engine.state.clone()))
                    .is_err()
            );
            let cancelled = tokio_util::sync::CancellationToken::new();
            cancelled.cancel();
            let mut caller = f.caller();
            caller.abort_token = Some(cancelled);
            assert!(f.authority(&caller).is_err());
            let authority = f.authority(&f.caller()).unwrap();
            PrivateDirectory::open_existing(&f.receiver)
                .unwrap()
                .atomic_replace(
                    OsStr::new("settings.json"),
                    br#"{"tools":{"profile":"full"},"session_memory":{"enabled":false}}"#,
                )
                .unwrap();
            assert!(authority.runner().is_err());
        })
        .await;
}

#[tokio::test]
async fn pure_registry_reads_and_stale_revision_do_not_create_remote_operation_namespaces() {
    let f = Fixture::new();
    let before = std::fs::read_dir(f.native.profile_path().unwrap())
        .unwrap()
        .count();
    let registry = registry::observe(&f.native, &f.engine).unwrap().unwrap();
    assert_eq!(registry.peers().unwrap()[0]["businessState"], "unknown");
    assert!(
        registry
            .bind("explicit-peer", "caller-forged-revision", &f.workspace)
            .is_err()
    );
    assert!(
        NativeRemoteJournal::read(&f.native, "never-executed")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(f.native.profile_path().unwrap())
            .unwrap()
            .count(),
        before
    );
}

#[tokio::test]
async fn accepted_original_protocol_output_publishes_partial_artifact_in_the_existing_native_office_store()
 {
    output_roundtrip(Fixture::new(), false).await;
}
#[tokio::test]
#[ignore = "Requires an explicitly pinned installed Native executable; performs no model request"]
async fn actual_installed_native_reader_composes_with_the_accepted_factory_and_existing_artifact_store()
 {
    let mut f = Fixture::new();
    let path = PathBuf::from(
        std::env::var_os("KCODER_REMOTE_TEST_NATIVE")
            .expect("explicit Native installation required"),
    );
    assert!(path.is_absolute() && path.is_file());
    f.native_program = Some(path);
    output_roundtrip(f, true).await;
}
async fn output_roundtrip(f: Fixture, read: bool) {
    use super::artifacts::NativeRemoteReceivedOutput;
    use kcoder_acp::outbound::OutboundPromptReceipt;
    use kcoder_types::integrations::core::*;
    use kcoder_types::integrations::office::*;
    f.engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = true;
    f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
        let authority=Arc::new(f.authority(&f.caller()).unwrap());
        let request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,
            request_id:"native-current-remote-output".into(),scope:f.native.scope().clone(),operation_id:Some("native-original-remote-output".into()),
            expected_revision:None,timeout_ms:1000,cancellation_ref:None,payload:json!({"prompt":"Frozen material, not authority"}).as_object().unwrap().clone()};
        let journal=NativeRemoteJournal::begin(&f.native,&request,authority.clone()).unwrap();
        // Protocol fixture facts exercise publication composition; no process/model success is claimed.
        for (stage,intent,receipt) in [
            (OutboundEffect::Spawn,json!({"expectedName":"kcoder","expectedVersion":kcoder_cli_commands::build_identity::version()}),json!({"ownedPid":1})),
            (OutboundEffect::Initialize,json!({"protocolVersion":1}),json!({"protocolVersion":1})),
            (OutboundEffect::Session,json!({"cwd":f.workspace,"mcpServers":[]}),json!({"sessionId":"actual-frozen-session"})),
            (OutboundEffect::Prompt,json!({"sessionId":"actual-frozen-session","prompt":[{"type":"text","text":"Frozen material, not authority"}]}),json!({"stopReason":"end_turn","updateCount":1})),
        ] {
            journal.before_effect(stage,&intent).unwrap();journal.record_receipt(stage,&receipt).unwrap();
        }
        let receipt=||OutboundPromptReceipt{
            session:serde_json::from_value(json!({"sessionId":"actual-frozen-session"})).unwrap(),
            response:serde_json::from_value(json!({"stopReason":"end_turn"})).unwrap(),
            updates:vec![serde_json::from_value(json!({"sessionId":"actual-frozen-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Literal remote output; business verification still pending."}}})).unwrap()],
        };
        let mut wrong=receipt();wrong.session=serde_json::from_value(json!({"sessionId":"another-peer-session"})).unwrap();
        assert!(NativeRemoteReceivedOutput::capture(&journal,wrong).is_err());
        let output=NativeRemoteReceivedOutput::capture(&journal,receipt()).unwrap();
        let published=output.publish(&journal,&f.engine,&f.caller()).unwrap();
        assert_eq!(published.verification.status,OfficeVerificationStatus::Partial);
        assert_eq!(published.verification.reader_status,OfficeVerificationStatus::Pending);
        assert_eq!(published.task.thread_id,f.attempt.thread_id);
        assert_eq!(published.task.turn_id,f.attempt.turn_id);
        assert_eq!(published.source_refs[0].id,"native-original-remote-output");
        let guard=NativeDomainGuard::observe(f.native.profile().unwrap(),f.native.scope(),NativeDomain::Office).unwrap().unwrap();
        let store=kcoder_state::integrations::office::OfficeStore::open_in(&guard.directory(f.native.profile().unwrap()).unwrap(),OsStr::new("data"),IntegrationOwner::from(f.native.scope())).unwrap().unwrap();
        let (bytes,total)=store.read_artifact_chunk(&OfficeArtifactRef{id:published.id.clone(),revision:published.revision},0,512*1024).unwrap();
        assert_eq!(total,bytes.len() as u64);
        assert_eq!(published.sha256,format!("{:x}",sha2::Sha256::digest(&bytes)));
        let body:Value=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["text"],"Literal remote output; business verification still pending.");
        assert_eq!(body["businessCompletion"],"unverified");
        let identities=validate_office_source_refs(&f.native,&published.source_refs).unwrap();
        assert_eq!(identities.len(),2);
        let assets=crate::app_server::integrations::office::native_assets::NativeOfficeFileAssets::capture(
            &f.native,&f.engine,Arc::new(Default::default()),None,
        ).unwrap();
        use crate::app_server::integrations::office::native_host::NativeOfficeAssets;
        let mut export_request=request.clone();export_request.operation_id=Some("remote-output-explicit-export".into());
        let exported=assets.prepare_export(&f.native,&export_request,&published,bytes.clone(),&tokio_util::sync::CancellationToken::new()).await.unwrap();
        assert!(exported["exportId"].as_str().is_some());
        assert!(validate_office_source_refs(&f.native,&published.source_refs[..1]).is_err());
        for index in 0..2 {
            let mut changed=published.source_refs.clone();changed[index].revision="f".repeat(64);
            assert!(validate_office_source_refs(&f.native,&changed).is_err());
        }
        let mut changed=published.source_refs.clone();changed[1].id="another-session".into();
        assert!(validate_office_source_refs(&f.native,&changed).is_err());
        let forged_native = OfficeResourceRef {kind:"native_remote_artifact".into(),
            id:"caller-selected-native-file".into(),revision:"e".repeat(64)};
        assert!(validate_office_source_refs(&f.native,std::slice::from_ref(&forged_native)).is_err());
        let mut changed=published.source_refs.clone();changed.push(forged_native);
        assert!(validate_office_source_refs(&f.native,&changed).is_err());

        if read {
            let runner = authority.runner().unwrap();
            let result = output.read(&journal, &runner, &f.engine, &f.caller()).await.unwrap();
            assert_eq!(result["complete"], true);
            assert!(result["chunks"].as_array().unwrap().iter().any(|chunk| chunk["text"].as_str().is_some_and(|text| text.contains("Literal remote output"))));
            assert_eq!(published.verification.status, OfficeVerificationStatus::Partial);
        }
        use kcoder_tools::integrations::remotes::{RemoteOperationAction,RemoteOperationInput};
        let mut management_input=RemoteOperationInput{action:RemoteOperationAction::Read,operation_id:request.operation_id.clone().unwrap(),expected_revision:None};
        let observed=super::management::manage_original(&f.native,&management_input).unwrap();
        assert_eq!(observed["receiver"]["state"],"outcome_unknown");
        assert_eq!(observed["executionTerminalConfirmed"],false);
        let revision=observed["operationRevision"].as_u64().unwrap();
        management_input.action=RemoteOperationAction::Cancel;management_input.expected_revision=Some(revision+1);
        assert!(super::management::manage_original(&f.native,&management_input).is_err());
        journal.check_current().unwrap();
        management_input.expected_revision=Some(revision);
        let cancelled=super::management::manage_original(&f.native,&management_input).unwrap();
        assert_eq!(cancelled["operationPhase"],"cancel_requested");
        assert_eq!(cancelled["executionTerminalConfirmed"],false);
        assert!(journal.check_current().is_err());
        assert!(output.publish(&journal,&f.engine,&f.caller()).is_err());
    }).await;
}
