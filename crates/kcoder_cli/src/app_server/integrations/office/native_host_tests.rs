//! Real private context/FD/Store tests. Metadata-only cases use an inert owned
//! program path and do not claim an available Node runtime. The explicit host
//! case below selects and actually runs the caller-provided native Node.
use super::*;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::path::{Path, PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    profile: PathBuf,
    context: NativeIntegrationContext,
    engine: QueryEngine,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
            .with_settings_persistence_path(profile.join("settings.json"));
        engine.settings.write().unwrap().integrations.office.enabled = true;
        let context = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "native-office-owned-test",
            "config-1",
        )
        .unwrap();
        Self {
            _temp: temp,
            profile,
            context,
            engine,
        }
    }
    fn package(&self) -> PathBuf {
        kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components")
    }
    fn inert_installed(&self) -> NativeOfficeInstalledPaths {
        NativeOfficeInstalledPaths::from_native_installation(
            &std::env::current_exe().unwrap(),
            &self.package(),
        )
        .unwrap()
    }
    fn request(&self, operation: Option<&str>, payload: Value) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("request-{}", uuid::Uuid::new_v4()),
            scope: self.context.scope().clone(),
            operation_id: operation.map(str::to_owned),
            expected_revision: None,
            timeout_ms: 30_000,
            cancellation_ref: None,
            payload: payload.as_object().unwrap().clone(),
        }
    }
    fn accepted_task(&self) -> OfficeTaskRef {
        let thread = self.engine.session_id();
        let directory = self.engine.session_storage_dir_for(&thread);
        let store = TurnAttemptStore::open(&directory, &thread).unwrap();
        store
            .begin(TurnAttemptRecord {
                client_presentation: None,
                version: 1,
                identity: TurnAttemptIdentity {
                    thread_id: thread.clone(),
                    turn_id: "native-accepted-turn".into(),
                    attempt_id: "native-accepted-attempt".into(),
                },
                parent_attempt_id: None,
                retry_operation_id: None,
                accepted_at_ms: 1,
                input_context_hash: "a".repeat(64),
                request_fingerprint: Some("b".repeat(64)),
                retained_input: None,
                status: TurnAttemptStatus::Accepted,
                completion: None,
            })
            .unwrap();
        OfficeTaskRef {
            thread_id: thread,
            turn_id: "native-accepted-turn".into(),
            run_id: None,
        }
    }
}
fn providers() -> NativeOfficeProviders {
    NativeOfficeProviders {
        tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
        ..Default::default()
    }
}

#[tokio::test]
async fn personal_assistant_execution_uses_native_policy_without_allowing_unknown_actions() {
    let fixture = Fixture::new();
    let composition = NativeOfficeComposition::initialize_metadata(
        &fixture.context,
        &fixture.engine,
        providers(),
        "initialize-execution-policy",
    )
    .unwrap();
    let host = NativeHost {
        binding: composition.binding.clone(),
        generator: None,
        providers: providers(),
    };
    for (action, decision) in [
        ("office.assistant.execute", "allow"),
        ("office.assistant.execute.arbitrary", "deny"),
        ("office.organization.publish", "deny"),
    ] {
        let request = fixture.request(None, json!({"action":action,"resources":{}}));
        let reply = host
            .call_port(
                IntegrationPort::Policy,
                "evaluateAction",
                &request,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(reply.status, IntegrationStatus::Completed);
        assert_eq!(reply.result.as_ref().unwrap()["decision"], decision);
    }
}

#[tokio::test]
async fn observe_is_pure_and_personal_management_uses_real_namespace_store() {
    let fixture = Fixture::new();
    let before = std::fs::read_dir(&fixture.profile)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        NativeOfficeComposition::observe(
            &fixture.context,
            &fixture.engine,
            fixture.inert_installed(),
            providers()
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        std::fs::read_dir(&fixture.profile)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>(),
        before
    );
    let composition = NativeOfficeComposition::initialize(
        &fixture.context,
        &fixture.engine,
        fixture.inert_installed(),
        providers(),
        "initialize-office",
    )
    .unwrap();
    let mut definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.meeting-minutes",
        "en",
    )
    .unwrap();
    definition.id = "personal.office.fixture".into();
    let save = fixture.request(Some("save-personal"), json!({"definition":definition}));
    let saved = composition
        .dispatch(
            &fixture.context,
            "integrations/assistant/saveDraft",
            &save,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(saved.status, IntegrationStatus::Completed);
    drop(composition);
    let reopened = NativeOfficeComposition::observe(
        &fixture.context,
        &fixture.engine,
        fixture.inert_installed(),
        providers(),
    )
    .unwrap()
    .unwrap();
    let read = fixture.request(None, json!({"id":"personal.office.fixture"}));
    let result = reopened
        .dispatch(
            &fixture.context,
            "integrations/assistant/read",
            &read,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, IntegrationStatus::Completed);
    assert!(result.result.as_ref().unwrap().contains_key("draft"));
    assert!(
        reopened
            .dispatch(
                &fixture.context,
                "integrations/office/arbitraryProgram",
                &read,
                &CancellationToken::new()
            )
            .await
            .unwrap()
            .status
            != IntegrationStatus::Completed
    );
}

#[tokio::test]
async fn organization_and_missing_native_ports_are_not_synthetic_allow_or_ready() {
    let fixture = Fixture::new();
    let composition = NativeOfficeComposition::initialize(
        &fixture.context,
        &fixture.engine,
        fixture.inert_installed(),
        NativeOfficeProviders::default(),
        "init",
    )
    .unwrap();
    let service = composition.service();
    let request = fixture.request(None, json!({"action":"office.organization.publish"}));
    let reply = service
        .host
        .call_port(
            IntegrationPort::Policy,
            "evaluateAction",
            &request,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.result.as_ref().unwrap()["decision"], "deny");
    let request = fixture.request(Some("missing-runtime"), json!({}));
    assert!(
        service
            .host
            .call_port(
                IntegrationPort::Runtime,
                "acceptTask",
                &request,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let fake = OfficeTaskRef {
        thread_id: fixture.engine.session_id(),
        turn_id: "invented-turn".into(),
        run_id: None,
    };
    assert!(
        service
            .host
            .validate_task(fixture.context.scope(), &fake)
            .is_err()
    );
    let input = OfficeResourceRef {
        kind: "input".into(),
        id: "not-an-accepted-native-input".into(),
        revision: "1".into(),
    };
    assert!(
        service
            .host
            .resolve_source_content_identities(&request, &[input], &CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn actual_profile_workspace_office_settings_and_namespace_identity_are_rechecked() {
    let fixture = Fixture::new();
    let composition = NativeOfficeComposition::initialize(
        &fixture.context,
        &fixture.engine,
        fixture.inert_installed(),
        providers(),
        "init",
    )
    .unwrap();
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = false;
    assert!(composition.verify(&fixture.context).is_err());
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = true;
    let domain = composition.binding.guard.namespace_id().to_owned();
    let namespace = fixture
        .context
        .profile()
        .unwrap()
        .open_entry_handle(OsStr::new(&domain))
        .unwrap()
        .open_child_directory()
        .unwrap();
    namespace
        .rename_no_replace(OsStr::new("data"), OsStr::new("retained-original-data"))
        .unwrap();
    namespace.create_private_child(OsStr::new("data")).unwrap();
    assert!(composition.verify(&fixture.context).is_err());
    assert!(
        NativeOfficeComposition::observe(
            &fixture.context,
            &fixture.engine,
            fixture.inert_installed(),
            providers()
        )
        .is_err()
    );
}

#[tokio::test]
async fn real_private_accepted_turn_ledger_rejects_a_guessed_turn() {
    let fixture = Fixture::new();
    let task = fixture.accepted_task();
    let authority = NativeOfficeAcceptedTurnAuthority;
    authority
        .validate(&fixture.context, &fixture.engine, &task)
        .unwrap();
    let mut guessed = task;
    guessed.turn_id = "guessed-but-well-formed".into();
    assert!(
        authority
            .validate(&fixture.context, &fixture.engine, &guessed)
            .is_err()
    );
}

#[tokio::test]
#[ignore = "Requires explicit native Node; selected by owned actual-host acceptance"]
async fn actual_personal_host_generates_and_reads_canonical_source_with_real_dataset_identity() {
    let node =
        std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE").expect("explicit actual Node path");
    let fixture = Fixture::new();
    let task = fixture.accepted_task();
    let installed =
        NativeOfficeInstalledPaths::from_native_installation(Path::new(&node), &fixture.package())
            .unwrap();
    let composition = NativeOfficeComposition::initialize(
        &fixture.context,
        &fixture.engine,
        installed,
        providers(),
        "native-initialize",
    )
    .unwrap();
    let data = OfficeDataset {
        schema_version: 1,
        id: "actual-source-r1".into(),
        revision: 1,
        owner: IntegrationOwner::from(fixture.context.scope()),
        task: Some(task.clone()),
        columns: vec![OfficeColumn {
            key: "amount".into(),
            title: "金额".into(),
            kind: OfficeColumnType::Number,
            unit: Some("元".into()),
        }],
        rows: vec![vec![json!(1234.56)], vec![Value::Null]],
        source_refs: vec![],
    };
    let expected_input_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&data).unwrap()));
    let create = fixture.request(Some("dataset-r1"), serde_json::to_value(&data).unwrap());
    let created = composition
        .dispatch(
            &fixture.context,
            "integrations/dataset/create",
            &create,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(created.status, IntegrationStatus::Completed);
    let generate=fixture.request(Some("actual-generation"),json!({"task":task,"sourceRefs":[{"kind":"dataset","id":"actual-source-r1","revision":"1"}],"specification":{"schemaVersion":1,"kind":"xlsx","title":"实际个人办公纵切","sheets":[{"name":"明细","columns":[{"key":"amount","title":"金额","type":"number"}],"rows":[[1234.56],[null]],"formulas":[{"cell":"A4","formula":"=SUM(A2:A3)"}]}]}}));
    let generated = composition
        .dispatch(
            &fixture.context,
            "integrations/office/generate",
            &generate,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        generated.status,
        IntegrationStatus::Completed,
        "{generated:?}"
    );
    let result = generated.result.as_ref().unwrap();
    let manifest: OfficeArtifactManifest =
        serde_json::from_value(result["manifest"].clone()).unwrap();
    let source = fixture.request(
        None,
        json!({"reference":{"id":manifest.id,"revision":manifest.revision}}),
    );
    let metadata = composition
        .dispatch(
            &fixture.context,
            "integrations/artifact/source",
            &source,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(metadata.status, IntegrationStatus::Completed);
    let descriptor: OfficeCanonicalSourceDescriptor =
        serde_json::from_value(metadata.result.as_ref().unwrap()["source"].clone()).unwrap();
    assert_eq!(descriptor.inputs[0].sha256, expected_input_hash);
    assert_ne!(
        descriptor.inputs[0].sha256,
        format!("{:x}", Sha256::digest(b"actual-source-r1"))
    );
    let (bytes, total) = composition
        .service
        .store
        .read_artifact_chunk(
            &OfficeArtifactRef {
                id: manifest.id.clone(),
                revision: 1,
            },
            0,
            512 * 1024,
        )
        .unwrap();
    assert_eq!(&bytes[..2], b"PK");
    assert_eq!(total, manifest.bytes);
    let reopened = NativeOfficeComposition::observe(
        &fixture.context,
        &fixture.engine,
        NativeOfficeInstalledPaths::from_native_installation(Path::new(&node), &fixture.package())
            .unwrap(),
        providers(),
    )
    .unwrap()
    .unwrap();
    let read=fixture.request(None,json!({"reference":{"id":manifest.id,"revision":1},"metadataOnly":false,"expectedSha256":descriptor.specification_sha256,"offset":0,"limit":64*1024}));
    let value = reopened
        .dispatch(
            &fixture.context,
            "integrations/artifact/source",
            &read,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(value.status, IntegrationStatus::Completed);
    assert!(
        value.result.as_ref().unwrap()["chunk"]
            .as_str()
            .unwrap()
            .contains("=SUM(A2:A3)")
    );
    let mut denied = read;
    denied.scope.identity_generation = "wrong-generation".into();
    assert!(
        reopened
            .dispatch(
                &fixture.context,
                "integrations/artifact/source",
                &denied,
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
}
