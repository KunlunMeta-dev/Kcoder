//! Port consumers only. Fixture replies do not prove native policy/model/task execution.
use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
};
struct Host {
    scope: IntegrationScope,
    decision: AtomicU8,
    mismatch: AtomicBool,
    calls: Mutex<Vec<(IntegrationPort, String, Value)>>,
    shared: Mutex<Vec<OfficeSharedAssistant>>,
    published: AtomicUsize,
    org_decision: AtomicU8,
    approved: AtomicBool,
}
#[async_trait]
impl OfficeHost for Host {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        ensure!(scope == &self.scope, "OFFICE_SCOPE_CHANGED");
        Ok(())
    }
    fn validate_task(&self, scope: &IntegrationScope, task: &OfficeTaskRef) -> Result<()> {
        self.validate_scope(scope)?;
        ensure!(
            !task.thread_id.is_empty() && !task.turn_id.is_empty(),
            "OFFICE_NATIVE_TASK_CONFLICT"
        );
        Ok(())
    }
    async fn validate_sources(
        &self,
        _: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        _: &CancellationToken,
    ) -> Result<()> {
        ensure!(
            sources.iter().all(|source| source.id == "input-1"
                || source.kind == "workflow"
                || source.id == "publication-fixture"),
            "OFFICE_INPUT_NOT_FOUND"
        );
        Ok(())
    }
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        _: &CancellationToken,
    ) -> Result<IntegrationReply> {
        self.calls.lock().unwrap().push((
            port,
            method.into(),
            Value::Object(request.payload.clone()),
        ));
        let mut status = IntegrationStatus::Completed;
        let result = match port {
            IntegrationPort::Policy => {
                json!({"decision":match if request.payload.get("action").and_then(Value::as_str).is_some_and(|action|action.starts_with("office.organization.")){self.org_decision.load(Ordering::SeqCst)}else{self.decision.load(Ordering::SeqCst)}{1=>"deny",2=>"unknown",_=>"allow"},"policyRevision":"policy-fixture","reasonCode":"fixture"})
            }
            IntegrationPort::Readiness => {
                json!({"identityGeneration":request.scope.identity_generation,"targetRevision":request.scope.target_revision,"observedAt":chrono::Utc::now().to_rfc3339(),"requestRevision":"request-fixture","capabilities":[{"capabilityId":"file.read","state":"ready","toolRefs":[{"name":"read","schemaRevision":"schema-fixture","sourceRevision":"source-fixture"}]},{"capabilityId":"document.create","state":"ready","toolRefs":[{"name":"OfficeDocument","schemaRevision":"schema-fixture","sourceRevision":"source-fixture"}]}]})
            }
            IntegrationPort::Model => {
                json!({"selectionKind":if self.mismatch.load(Ordering::SeqCst){"explicit"}else{"inherit_current"},"model":{"providerId":"provider-fixture","modelId":"model-fixture","apiFormat":"openai","chatProtocol":"chat_completions","contextWindowTokens":128000,"maxOutputTokens":8192,"requestOutputLimits":{},"outputHeadroomTokens":8192,"text":true,"tools":true,"vision":false,"reasoning":false,"structuredOutput":false,"reasoningEffort":null,"extraBodyConfigured":false,"requestOverrideFields":[],"revision":"model-revision-fixture","boundary":"next_turn","sources":{}},"policyRef":null,"budget":{"reservationState":"not_reserved","costKnown":false}})
            }
            IntegrationPort::Delivery => {
                status = IntegrationStatus::Accepted;
                json!({"deliveryId":request.payload.get("deliveryId"),"deliveryState":"queued"})
            }
            IntegrationPort::Runtime => {
                status = IntegrationStatus::Accepted;
                json!({"threadId":"native-thread-fixture","turnId":"native-turn-fixture","state":"running"})
            }
            _ => anyhow::bail!("OFFICE_PORT_UNCONFIRMED"),
        };
        Ok(IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            status,
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: "2026-10-24T00:00:00Z".into(),
            result: IntegrationNullable::Value(result.as_object().unwrap().clone()),
            error: IntegrationNullable::Null,
        })
    }
    async fn generate(
        &self,
        _: &IntegrationRequest,
        _: &Value,
        _: &CancellationToken,
    ) -> Result<OfficeGeneratedFile> {
        anyhow::bail!("OFFICE_COMPONENT_UNAVAILABLE")
    }
    async fn authorize_artifact_action(
        &self,
        _: &IntegrationRequest,
        _: &Value,
        _: &CancellationToken,
    ) -> Result<()> {
        ensure!(
            self.approved.load(Ordering::SeqCst),
            "OFFICE_ACTION_AUTHORIZATION_UNAVAILABLE"
        );
        Ok(())
    }
    async fn organization_templates(
        &self,
        _: &IntegrationRequest,
        _: &CancellationToken,
    ) -> Result<Vec<OfficeSharedAssistant>> {
        Ok(self.shared.lock().unwrap().clone())
    }
    async fn publish_organization_template(
        &self,
        _: &IntegrationRequest,
        version: &OfficeAssistantVersion,
        _: &CancellationToken,
    ) -> Result<OfficeResourceRef> {
        self.published.fetch_add(1, Ordering::SeqCst);
        ensure!(
            version.definition.resources.is_empty()
                && version.definition.workflow_ref.is_none()
                && version.definition.model_selection == OfficeModelSelection::InheritCurrent,
            "OFFICE_ORGANIZATION_BINDINGS_MUST_BE_DETACHED"
        );
        let publication = OfficeResourceRef {
            kind: "publication".into(),
            id: "publication-fixture".into(),
            revision: "1".into(),
        };
        self.shared.lock().unwrap().push(OfficeSharedAssistant {
            version: version.clone(),
            publication: publication.clone(),
        });
        Ok(publication)
    }
    async fn archive_organization_template(
        &self,
        _: &IntegrationRequest,
        publication: &OfficeResourceRef,
        _: &CancellationToken,
    ) -> Result<()> {
        for item in self.shared.lock().unwrap().iter_mut() {
            if item.publication == *publication {
                item.version.archived = true;
            }
        }
        Ok(())
    }
    async fn generator_readiness(
        &self,
        _: &IntegrationRequest,
        _: &CancellationToken,
    ) -> Result<Value> {
        Ok(json!({"status":"available","supportedFormats":["docx","xlsx","pptx"]}))
    }
    async fn prepare_export(
        &self,
        _: &IntegrationRequest,
        _: &OfficeArtifactManifest,
        _: Vec<u8>,
        _: &CancellationToken,
    ) -> Result<Value> {
        anyhow::bail!("OFFICE_EXPORT_PROVIDER_UNAVAILABLE")
    }
    async fn verify(
        &self,
        _: &IntegrationRequest,
        _: &OfficeArtifactManifest,
        _: Vec<u8>,
        _: &CancellationToken,
    ) -> Result<OfficeVerification> {
        anyhow::bail!("OFFICE_DEPENDENCY_UNAVAILABLE")
    }
}
fn setup() -> (tempfile::TempDir, OfficeService, Arc<Host>) {
    setup_org(None)
}
fn setup_org(organization: Option<&str>) -> (tempfile::TempDir, OfficeService, Arc<Host>) {
    let root = tempfile::tempdir().unwrap();
    let scope = IntegrationScope {
        account_id: "a".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        identity_generation: "identity-1".into(),
        target_revision: "target-1".into(),
        organization_id: organization.map(|id| IntegrationNullable::Value(id.into())),
    };
    let store = Arc::new(
        OfficeStore::create(&root.path().join("office"), IntegrationOwner::from(&scope)).unwrap(),
    );
    let host = Arc::new(Host {
        scope,
        decision: AtomicU8::new(0),
        mismatch: AtomicBool::new(false),
        calls: Mutex::new(vec![]),
        shared: Mutex::new(vec![]),
        published: AtomicUsize::new(0),
        org_decision: AtomicU8::new(0),
        approved: AtomicBool::new(false),
    });
    let settings = OfficeSettings {
        enabled: true,
        allow_organization_templates: organization.is_some(),
        ..Default::default()
    };
    let service = OfficeService::new(store, settings, host.clone()).unwrap();
    (root, service, host)
}
fn request(host: &Host, operation: &str, payload: Value) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "request-fixture".into(),
        scope: host.scope.clone(),
        operation_id: Some(operation.into()),
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    }
}
fn adoption(host: &Host, operation: &str) -> IntegrationRequest {
    request(
        host,
        operation,
        json!({"id":"builtin.meeting-minutes","version":"1","language":"en","inputs":{"title":"Meeting","materialRefs":["input-1"]},"startTask":true}),
    )
}

#[tokio::test]
async fn adopted_expert_port_message_contains_only_enabled_skill_snapshots() {
    let (_root, service, host) = setup();
    let mut definition =
        builtin_office_assistant_version("builtin.meeting-minutes", "en", "1").unwrap();
    definition.id = "personal.reviewed-skills".into();
    definition.allowed_tools = Some(vec![]);
    definition.capabilities.clear();
    definition.skills = vec![
        OfficeAssistantSkill {
            slug: "enabled".into(),
            title: "Enabled".into(),
            description: String::new(),
            content: "ENABLED_SKILL_SOURCE_MARKER".into(),
            enabled: true,
            allowed_tools: None,
        },
        OfficeAssistantSkill {
            slug: "disabled".into(),
            title: "Disabled".into(),
            description: String::new(),
            content: "DISABLED_SKILL_PRIVATE_MARKER".into(),
            enabled: false,
            allowed_tools: None,
        },
    ];
    let draft = service
        .store
        .save_draft("create-skilled-expert", definition, None, 1)
        .unwrap();
    service
        .store
        .save_version(
            "pin-skilled-expert",
            &draft.definition.id,
            "1",
            draft.revision,
            2,
        )
        .unwrap();
    let mut request = adoption(&host, "adopt-skilled-expert");
    request
        .payload
        .insert("id".into(), json!(draft.definition.id));
    service
        .dispatch(
            "integrations/assistant/adopt",
            &request,
            "office.assistant.adopt",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let calls = host.calls.lock().unwrap();
    let payload = &calls
        .iter()
        .find(|(port, method, _)| *port == IntegrationPort::Runtime && method == "acceptTask")
        .unwrap()
        .2;
    let text = payload["message"]["text"].as_str().unwrap();
    assert!(text.contains("ENABLED_SKILL_SOURCE_MARKER"));
    assert!(!text.contains("DISABLED_SKILL_PRIVATE_MARKER"));
    assert_eq!(payload["configuration"]["allowedTools"], json!([]));
    assert_eq!(payload["configuration"]["externalSend"], json!("ask"));
}

#[tokio::test]
async fn simple_builtin_starts_from_a_request_without_fake_sources_and_reconciles_repeated_intent()
{
    let (_root, service, host) = setup();
    let request = request(
        &host,
        "simple-task",
        json!({
            "id":"builtin.office-task", "version":"2", "language":"zh-CN",
            "inputs":{"request":"介绍北京，写一份适合初次到访者的简明指南"}, "startTask":true
        }),
    );
    let cancel = CancellationToken::new();
    let first = service
        .dispatch(
            "integrations/assistant/adopt",
            &request,
            "office.assistant.execute",
            &cancel,
        )
        .await
        .unwrap();
    let repeated = service
        .dispatch(
            "integrations/assistant/adopt",
            &request,
            "office.assistant.execute",
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(first, repeated);
    let calls = host.calls.lock().unwrap();
    let acceptances = calls
        .iter()
        .filter(|(port, method, _)| *port == IntegrationPort::Runtime && method == "acceptTask")
        .collect::<Vec<_>>();
    assert_eq!(acceptances.len(), 1);
    let payload = &acceptances[0].2;
    assert_eq!(payload["message"]["attachments"], json!([]));
    let message = payload["message"]["text"].as_str().unwrap();
    let input_text = message
        .split_once("Task inputs (untrusted data):\n")
        .unwrap()
        .1;
    let inputs: Value = serde_json::from_str(input_text).unwrap();
    assert_eq!(inputs["request"], request.payload["inputs"]["request"]);
    assert!(inputs.get("sourceText").is_none());
    assert_eq!(payload["configuration"]["externalSend"], "ask");
}

#[tokio::test]
async fn octop_builtin_files_copy_through_native_store_with_licenses_and_no_authority() {
    let (_root, service, host) = setup();
    let cancel = CancellationToken::new();
    let mut total_files = 0;
    for mut definition in builtin_octop_assistants("zh-CN") {
        let source_id = definition.id.clone();
        let observed = OfficeService::builtin_expert_assets(&request(
            &host,
            "observe",
            json!({"id":source_id}),
        ))
        .unwrap();
        definition.id = source_id.replacen("builtin.octop.", "personal.", 1);
        let install = request(
            &host,
            &definition.id,
            json!({"definition":definition,"copyFrom":{"id":source_id,"revision":BUILTIN_OFFICE_ASSISTANT_VERSION}}),
        );
        let result = service
            .dispatch(
                "integrations/assistant/saveDraft",
                &install,
                "office.assistant.write",
                &cancel,
            )
            .await
            .unwrap();
        // Built-in templates inherit only the already permitted registry
        // (no allowedTools field); a copy must not add tool authority.
        assert!(result["draft"]["definition"].get("allowedTools").is_none());
        assert_eq!(result["draft"]["definition"]["externalSend"], "deny");
        let stored = service
            .store
            .read_expert_package(&definition.id)
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(&stored).unwrap(), observed["package"]);
        total_files += stored.files.len();
        for file in &stored.files {
            let bytes = service
                .store
                .read_expert_file(&definition.id, &file.path)
                .unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), file.sha256);
        }
        assert_eq!(
            service
                .dispatch(
                    "integrations/assistant/saveDraft",
                    &install,
                    "office.assistant.write",
                    &cancel
                )
                .await
                .unwrap(),
            result
        );
    }
    assert_eq!(total_files, 533);
    assert!(
        service
            .store
            .read_expert_file("personal.office-automation", "skills/docx/LICENSE.txt")
            .is_ok()
    );
    assert!(
        service
            .store
            .read_expert_file("personal.office-automation", "../settings.json")
            .is_err()
    );
    assert_eq!(host.published.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn current_catalog_keeps_simple_entry_first_and_explicit_legacy_versions_unchanged() {
    let (_root, service, host) = setup();
    let catalog_request = request(&host, "catalog", json!({"limit":1,"language":"en"}));
    let catalog = OfficeService::builtin_assistant_catalog(&catalog_request).unwrap();
    assert_eq!(
        catalog["items"][0]["definition"]["id"],
        "builtin.office-task"
    );
    assert_eq!(catalog["items"][0]["version"], "2");
    let cancel = CancellationToken::new();
    let listed = service
        .dispatch(
            "integrations/assistant/list",
            &catalog_request,
            "office.assistant.read",
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        listed["items"][0]["definition"]["id"],
        "builtin.office-task"
    );
    let legacy = service
        .dispatch(
            "integrations/assistant/read",
            &request(
                &host,
                "legacy",
                json!({"id":"builtin.meeting-minutes","version":"1","language":"en"}),
            ),
            "office.assistant.read",
            &cancel,
        )
        .await
        .unwrap();
    let original = builtin_office_assistant_version("builtin.meeting-minutes", "en", "1").unwrap();
    assert_eq!(
        legacy["definition"],
        serde_json::to_value(&original).unwrap()
    );
    let saved = service
        .read_assistant_version("builtin.meeting-minutes", "1", "en")
        .unwrap();
    assert_eq!(saved.version, "1");
    assert_eq!(
        saved.definition_sha256,
        hash(&serde_json::to_vec(&original).unwrap())
    );
    assert!(
        service
            .read_assistant_version("builtin.office-task", "1", "en")
            .is_err()
    );
}

#[tokio::test]
async fn assistant_static_check_reads_actual_dependencies_without_adoption_or_budget_reservation() {
    let (_root, service, host) = setup();
    let definition =
        builtin_office_assistant_version("builtin.meeting-minutes", "en", "1").unwrap();
    let mut check = request(&host, "must-not-reserve", json!({"definition":definition}));
    check.operation_id = None;
    let report = service
        .dispatch(
            "integrations/assistant/validate",
            &check,
            "office.assistant.validate",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(report["staticOnly"], true);
    assert_eq!(report["adoptable"], false);
    assert_eq!(
        report["readiness"]["identityGeneration"],
        host.scope.identity_generation
    );
    assert_eq!(
        report["model"]["budget"]["reservationState"],
        "not_reserved"
    );
    assert_eq!(report["model"]["budget"]["costKnown"], false);
    assert!(
        report["requiredInputFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "title")
    );
    let calls = host.calls.lock().unwrap();
    assert!(calls.iter().any(
        |(port, method, _)| *port == IntegrationPort::Readiness && method == "inspectReadiness"
    ));
    assert!(
        calls.iter().any(
            |(port, method, _)| *port == IntegrationPort::Model && method == "resolveSelection"
        )
    );
    assert!(calls.iter().all(|(port, _, _)| matches!(
        port,
        IntegrationPort::Policy | IntegrationPort::Readiness | IntegrationPort::Model
    )));
    assert!(
        service
            .store
            .read_operation("must-not-reserve")
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn assistant_static_check_keeps_missing_resources_and_unresolved_model_unknown() {
    let (_root, service, host) = setup();
    host.mismatch.store(true, Ordering::SeqCst);
    let mut definition = builtin_office_assistant("builtin.meeting-minutes", "en").unwrap();
    definition.resources.push(OfficeResourceRef {
        kind: "office_input".into(),
        id: "missing-current-input".into(),
        revision: "1".into(),
    });
    let mut check = request(&host, "no-write", json!({"definition":definition}));
    check.operation_id = None;
    let report = service
        .dispatch(
            "integrations/assistant/validate",
            &check,
            "office.assistant.validate",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(report["model"].is_null());
    assert_eq!(report["modelReasonCode"], "OFFICE_MODEL_SELECTION_MISMATCH");
    assert_eq!(report["resources"][0]["state"], "unknown");
    assert_eq!(
        report["resources"][0]["reasonCode"],
        "OFFICE_INPUT_NOT_FOUND"
    );
    assert_eq!(report["adoptable"], false);
    assert!(service.store.read_operation("no-write").unwrap().is_none());
}

#[tokio::test]
async fn canonical_byte_read_rechecks_current_policy_instead_of_trusting_saved_descriptor() {
    let (_root, service, host) = setup();
    let task = OfficeTaskRef {
        thread_id: "thread-fixture".into(),
        turn_id: "turn-fixture".into(),
        run_id: None,
    };
    let spec = json!({"schemaVersion":1,"kind":"docx","title":"Private complete source","sourceRefs":[],"paragraphs":[{"text":"Full confidential source stays in private storage"}]});
    service
        .store
        .prepare_canonical_generation("native-generation", task.clone(), &spec, vec![], 1)
        .unwrap();
    let bytes = b"controlled State fixture, not reader acceptance";
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: "canonical-file".into(),
        revision: 1,
        owner: service.store.owner().clone(),
        task,
        kind: OfficeArtifactKind::Document,
        title: "Owned result".into(),
        format: OfficeFileFormat::Docx,
        bytes: bytes.len() as u64,
        sha256: hash(bytes),
        source_refs: vec![],
        verification: OfficeVerification {
            status: OfficeVerificationStatus::Pending,
            completed_checks: vec![],
            pending_checks: vec!["reader".into()],
            reader_status: OfficeVerificationStatus::Pending,
            formula_calculation: "not_applicable".into(),
        },
        dataset: None,
        created_at_ms: 1,
        presentation: None,
    };
    service
        .store
        .publish_generated_artifact(
            "publish",
            "native-generation",
            manifest,
            bytes,
            OfficeGeneratorIdentity {
                component: "controlled-fixture".into(),
                version: "1.0.0".into(),
                schema_revision: "office-generation/v1".into(),
                implementation_sha256: "a".repeat(64),
                dependency_lock_sha256: "b".repeat(64),
            },
        )
        .unwrap();
    let metadata = request(
        &host,
        "read-metadata",
        json!({"reference":{"id":"canonical-file","revision":1}}),
    );
    let token = CancellationToken::new();
    let result = service
        .dispatch(
            "integrations/artifact/source",
            &metadata,
            "office.artifact.source.read",
            &token,
        )
        .await
        .unwrap();
    assert!(result["chunk"].is_null());
    let sha = result["source"]["specificationSha256"].as_str().unwrap();
    let read = request(
        &host,
        "read-bytes",
        json!({"reference":{"id":"canonical-file","revision":1},"metadataOnly":false,"expectedSha256":sha,"offset":0,"limit":64}),
    );
    assert!(
        service
            .dispatch(
                "integrations/artifact/source",
                &read,
                "office.artifact.source.read",
                &token
            )
            .await
            .unwrap()["chunk"]
            .as_str()
            .unwrap()
            .len()
            <= 64
    );
    host.decision.store(1, Ordering::SeqCst);
    assert!(
        service
            .dispatch(
                "integrations/artifact/source",
                &read,
                "office.artifact.source.read",
                &token
            )
            .await
            .is_err()
    );
    assert!(
        service
            .store
            .prepared_generation_specification("native-generation")
            .unwrap()["paragraphs"]
            .is_array()
    );
}
#[tokio::test]
async fn completed_policy_deny_or_unknown_never_saves_a_draft() {
    for decision in [1, 2] {
        let (_root, service, host) = setup();
        host.decision.store(decision, Ordering::SeqCst);
        let mut definition = builtin_office_assistant("builtin.meeting-minutes", "en").unwrap();
        definition.id = "personal-fixture".into();
        let request = request(&host, "save", json!({"definition":definition}));
        assert!(
            service
                .dispatch(
                    "integrations/assistant/saveDraft",
                    &request,
                    "office.assistant.write",
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert!(service.store.list_drafts().unwrap().is_empty());
    }
}
#[tokio::test]
async fn repeated_adoption_starts_one_native_task_and_does_not_claim_task_completion() {
    let (_root, service, host) = setup();
    let request = adoption(&host, "adopt-1");
    let token = CancellationToken::new();
    let first = service
        .dispatch(
            "integrations/assistant/adopt",
            &request,
            "office.assistant.adopt",
            &token,
        )
        .await
        .unwrap();
    assert_eq!(first["nativeTask"]["state"], "running");
    assert_eq!(first["businessComplete"], false);
    let second = service
        .dispatch(
            "integrations/assistant/adopt",
            &request,
            "office.assistant.adopt",
            &token,
        )
        .await
        .unwrap();
    assert_eq!(first, second);
    let calls = host.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(port, method, _)| *port == IntegrationPort::Runtime && method == "acceptTask")
            .count(),
        1
    );
    let ready = calls
        .iter()
        .find(|(port, _, _)| *port == IntegrationPort::Readiness)
        .unwrap();
    assert_eq!(ready.2["resourceRefs"][0]["kind"], "input");
}
#[tokio::test]
async fn model_selection_mismatch_and_bad_inputs_stop_before_native_acceptance() {
    let (_root, service, host) = setup();
    host.mismatch.store(true, Ordering::SeqCst);
    assert!(
        service
            .dispatch(
                "integrations/assistant/adopt",
                &adoption(&host, "mismatch"),
                "office.assistant.adopt",
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        !host
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(port, _, _)| *port == IntegrationPort::Runtime)
    );
    host.mismatch.store(false, Ordering::SeqCst);
    let mut bad = adoption(&host, "bad");
    bad.payload["inputs"] = json!({"title":"missing material"});
    assert!(
        service
            .dispatch(
                "integrations/assistant/adopt",
                &bad,
                "office.assistant.adopt",
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn personal_import_detaches_bindings_without_widening_an_empty_tool_restriction() {
    let (_root, service, host) = setup();
    let mut definition = builtin_office_assistant("builtin.meeting-minutes", "en").unwrap();
    definition.allowed_tools = Some(vec![]);
    definition.model_selection = OfficeModelSelection::Explicit {
        provider: "private-provider".into(),
        model: "private-model".into(),
    };
    definition.resources = vec![OfficeResourceRef {
        kind: "connection".into(),
        id: "private-connection".into(),
        revision: "private-revision".into(),
    }];
    definition.workflow_ref = Some(OfficeWorkflowRef {
        definition_id: "private-workflow".into(),
        version: 7,
    });
    let request = request(
        &host,
        "import",
        json!({"id":"personal-imported","definition":definition}),
    );
    let value = service
        .dispatch(
            "integrations/assistant/import",
            &request,
            "office.assistant.import",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let saved: OfficeAssistantDraft = serde_json::from_value(value["draft"].clone()).unwrap();
    assert_eq!(saved.definition.allowed_tools, Some(vec![]));
    assert!(saved.definition.resources.is_empty());
    assert!(saved.definition.workflow_ref.is_none());
    assert_eq!(
        saved.definition.model_selection,
        OfficeModelSelection::InheritCurrent
    );
}

#[tokio::test]
async fn organization_publication_is_native_and_detached_and_unknown_policy_does_not_publish() {
    let (_root, service, host) = setup_org(Some("org-fixture"));
    let mut definition = builtin_office_assistant("builtin.meeting-minutes", "en").unwrap();
    definition.id = "org-meeting".into();
    definition.scope = OfficeAssistantScope::Organization;
    definition.allowed_tools = Some(vec!["read".into(), "OfficeDocument".into()]);
    definition.resources = vec![OfficeResourceRef {
        kind: "connection".into(),
        id: "private-connection".into(),
        revision: "7".into(),
    }];
    definition.workflow_ref = Some(OfficeWorkflowRef {
        definition_id: "private-workflow".into(),
        version: 3,
    });
    definition.model_selection = OfficeModelSelection::Explicit {
        provider: "private-provider".into(),
        model: "private-model".into(),
    };
    service
        .dispatch(
            "integrations/assistant/saveDraft",
            &request(&host, "draft-org", json!({"definition":definition})),
            "office.assistant.write",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut save = request(
        &host,
        "publish-org",
        json!({"id":"org-meeting","version":"1"}),
    );
    save.expected_revision = Some("1".into());
    let result = service
        .dispatch(
            "integrations/assistant/saveVersion",
            &save,
            "office.assistant.write",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["publication"]["id"], "publication-fixture");
    assert_eq!(host.published.load(Ordering::SeqCst), 1);
    let published = host.shared.lock().unwrap()[0].clone();
    assert_eq!(
        published.version.definition.allowed_tools,
        Some(vec!["read".into(), "OfficeDocument".into()])
    );
    assert!(published.version.definition.resources.is_empty());
    service
        .dispatch(
            "integrations/assistant/saveVersion",
            &save,
            "office.assistant.write",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(host.published.load(Ordering::SeqCst), 1);
    host.org_decision.store(2, Ordering::SeqCst);
    let listed = service
        .dispatch(
            "integrations/assistant/list",
            &request(&host, "list", json!({"limit":10})),
            "office.assistant.read",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(listed["organizationState"], "unavailable");
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("organizationPublication").is_none())
    );
}

#[tokio::test]
async fn native_confirmation_is_required_and_delivery_acceptance_is_not_replayed_or_completion() {
    let (_root, mut service, host) = setup();
    service.settings.allow_external_delivery = true;
    let bytes = br#"{"value":1}"#;
    let manifest = OfficeArtifactManifest {
        schema_version: 1,
        id: "actual-artifact".into(),
        revision: 1,
        owner: service.store.owner().clone(),
        task: OfficeTaskRef {
            thread_id: "thread-fixture".into(),
            turn_id: "turn-fixture".into(),
            run_id: None,
        },
        kind: OfficeArtifactKind::Document,
        title: "Owned result".into(),
        format: OfficeFileFormat::Json,
        bytes: bytes.len() as u64,
        sha256: hash(bytes),
        source_refs: vec![],
        verification: OfficeVerification {
            status: OfficeVerificationStatus::Partial,
            completed_checks: vec!["content_identity".into()],
            pending_checks: vec!["semantic_acceptance".into()],
            reader_status: OfficeVerificationStatus::Unavailable,
            formula_calculation: "not_applicable".into(),
        },
        dataset: None,
        created_at_ms: 1,
        presentation: None,
    };
    service
        .store
        .publish_artifact("publish-actual", manifest, bytes)
        .unwrap();
    let token = CancellationToken::new();
    let payload = json!({"reference":{"id":"actual-artifact","revision":1},"action":"send","destination":{"kind":"destination_grant","id":"destination-fixture","revision":"1"}});
    let prepared = service
        .dispatch(
            "integrations/artifact/prepareAction",
            &request(&host, "prepare-denied", payload.clone()),
            "office.artifact.action",
            &token,
        )
        .await
        .unwrap();
    let mut execute = request(
        &host,
        prepared["executionOperationId"].as_str().unwrap(),
        json!({"preparedOperationId":"prepare-denied"}),
    );
    assert!(
        service
            .dispatch(
                "integrations/artifact/executeAction",
                &execute,
                "office.artifact.action",
                &token
            )
            .await
            .is_err()
    );
    assert!(
        !host
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(port, _, _)| *port == IntegrationPort::Delivery)
    );
    host.approved.store(true, Ordering::SeqCst);
    let prepared = service
        .dispatch(
            "integrations/artifact/prepareAction",
            &request(&host, "prepare-allowed", payload),
            "office.artifact.action",
            &token,
        )
        .await
        .unwrap();
    execute = request(
        &host,
        prepared["executionOperationId"].as_str().unwrap(),
        json!({"preparedOperationId":"prepare-allowed"}),
    );
    let first = service
        .dispatch(
            "integrations/artifact/executeAction",
            &execute,
            "office.artifact.action",
            &token,
        )
        .await
        .unwrap();
    assert_eq!(first["delivery"]["deliveryState"], "queued");
    assert_eq!(first["businessComplete"], false);
    let second = service
        .dispatch(
            "integrations/artifact/executeAction",
            &execute,
            "office.artifact.action",
            &token,
        )
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(
        host.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(port, _, _)| *port == IntegrationPort::Delivery)
            .count(),
        1
    );
}
