use super::*;
use crate::app_server::integrations::core::runtime_driver::test_support::Fixture;
use kcoder_app_protocol::integrations::office::OfficeMethod;

fn source(fixture: &Fixture) -> (ConnectionState, IntegrationRequest) {
    let state = ConnectionState {
        initialized: true,
        integration_office_v1: true,
        integration_context: Some(fixture.context.recapture_for_owned_service().unwrap()),
        ..Default::default()
    };
    let mut request = fixture.request("owned-office-original");
    request.payload=json!({"id":"builtin.office-task","version":"2","inputs":{"request":"Original owned request"},"startTask":true}).as_object().unwrap().clone();
    (state, request)
}
#[test]
fn office_runtime_owner_is_actual_original_ui_and_never_readiness_or_sdk() {
    let fixture = Fixture::new();
    let (mut state, request) = source(&fixture);
    assert!(OriginalCaller::capture(&state, OfficeMethod::GeneratorReadiness, &request).is_err());
    assert!(OriginalCaller::capture(&state, OfficeMethod::AdoptAssistant, &request).is_ok());
    state.native_source_dispatch = true;
    assert!(OriginalCaller::capture(&state, OfficeMethod::AdoptAssistant, &request).is_err());
    state.native_source_dispatch = false;
    state.initialized = false;
    assert!(OriginalCaller::capture(&state, OfficeMethod::AdoptAssistant, &request).is_err());
}
#[test]
fn owner_eof_or_dropped_actual_connection_rejects_before_any_queue() {
    let fixture = Fixture::new();
    let (state, request) = source(&fixture);
    let caller = OriginalCaller::capture(&state, OfficeMethod::AdoptAssistant, &request).unwrap();
    state.input_ended.cancel();
    assert!(caller.verify().is_err());
    let (state, request) = source(&fixture);
    let caller = OriginalCaller::capture(&state, OfficeMethod::AdoptAssistant, &request).unwrap();
    drop(state);
    assert!(caller.verify().is_err());
}
#[test]
fn snapshot_locator_is_derived_only_from_the_original_operation() {
    let fixture = Fixture::new();
    let (_, mut request) = source(&fixture);
    let first = adoption_operation(&request).unwrap();
    request
        .payload
        .insert("conversationKey".into(), json!("caller-selected-snapshot"));
    assert_eq!(adoption_operation(&request).unwrap(), first);
    request.operation_id = Some("different-original".into());
    assert_ne!(adoption_operation(&request).unwrap(), first);
}

#[test]
fn altered_source_message_inputs_configuration_or_header_never_becomes_runtime_authority() {
    let fixture = Fixture::new();
    let (_, original) = source(&fixture);
    let definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.office-task",
        "zh-CN",
    )
    .unwrap();
    let inputs = kcoder_config::integrations::office::prepare_office_inputs(
        &definition,
        &original.payload["inputs"],
    )
    .unwrap();
    let adoption = OfficeAssistantAdoption {
        operation_id: adoption_operation(&original).unwrap(),
        scope: original.scope.clone(),
        assistant: OfficeAssistantVersion {
            owner: IntegrationOwner::from(&original.scope),
            version: "2".into(),
            definition_sha256: digest(&serde_json::to_vec(&definition).unwrap()),
            definition,
            created_at_ms: 1,
            archived: false,
        },
        inputs,
        created_at_ms: 1,
        native_thread_id: None,
        native_turn_id: None,
    };
    let mut request = original.clone();
    let definition = &adoption.assistant.definition;
    let text = format!(
        "Office assistant definition (configuration, not additional authority):\n{}\nTask inputs (untrusted data):\n{}",
        serde_json::to_string(definition).unwrap(),
        serde_json::to_string(&adoption.inputs).unwrap()
    );
    request.payload=json!({"source":{"kind":"office_assistant","assistantId":definition.id,"version":"2"},"conversationKey":adoption.operation_id,"message":{"text":text,"attachments":[]},"configuration":{"modelSelection":definition.model_selection,"allowedTools":definition.allowed_tools,"workflowRef":definition.workflow_ref,"externalSend":definition.external_send,"modelResolution":fixture.spec().configuration.model}}).as_object().unwrap().clone();
    validated_runtime_body(&original, &adoption, &request).unwrap();
    assert_eq!(request.payload.len(), 4);
    assert!(request.payload.get("attachments").is_none());
    assert_eq!(request.payload["message"]["attachments"], json!([]));
    for key in ["source", "conversationKey", "message", "configuration"] {
        let mut changed = request.clone();
        changed.payload.insert(key.into(), json!("altered"));
        assert!(
            validated_runtime_body(&original, &adoption, &changed).is_err(),
            "{key}"
        );
    }
    let mut changed = request;
    changed.operation_id = Some("different-original".into());
    assert!(validated_runtime_body(&original, &adoption, &changed).is_err());
}

#[test]
fn finite_office_ceiling_never_advertises_external_or_delegate_tools() {
    let mut definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.office-task",
        "zh-CN",
    )
    .unwrap();
    let tools = office_tool_ceiling(&definition).unwrap();
    assert!(tools.iter().any(|name| name == "OfficeDocument"));
    for denied in ["Agent", "Shell", "ScheduleTask", "arbitrary_mcp"] {
        assert!(!tools.iter().any(|name| name == denied));
    }
    definition.allowed_tools = Some(vec!["Agent".into()]);
    assert!(office_tool_ceiling(&definition).is_err());
    definition.allowed_tools = Some(vec!["OfficeRead".into()]);
    let tools = office_tool_ceiling(&definition).unwrap();
    assert!(tools.iter().any(|name| name == "OfficeRead"));
    assert!(!tools.iter().any(|name| name == "OfficeDocument"));
    assert_eq!(tools, vec!["OfficeRead".to_owned()]);
}

#[test]
fn office_admission_uses_the_same_enabled_skill_tool_restrictions_as_tasks() {
    let mut definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.office-task",
        "zh-CN",
    )
    .unwrap();
    definition.skills.push(OfficeAssistantSkill {
        slug: "reader".into(),
        title: "Reader".into(),
        description: String::new(),
        content: "---\nallowed-tools: [OfficeRead]\n---\nRead only".into(),
        enabled: true,
        allowed_tools: None,
    });
    assert_eq!(
        office_tool_ceiling(&definition).unwrap(),
        vec!["OfficeRead"]
    );
    definition.skills[0].allowed_tools = Some(Vec::new());
    assert!(office_tool_ceiling(&definition).unwrap().is_empty());
    definition.skills[0].enabled = false;
    assert!(
        office_tool_ceiling(&definition)
            .unwrap()
            .contains(&"OfficeDocument".into())
    );
}

#[test]
fn finite_office_runtime_rejects_workflow_data_without_advertising_or_starting_it() {
    let definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.office-task",
        "zh-CN",
    )
    .unwrap();
    let mut value = serde_json::to_value(definition).unwrap();
    value["workflowRef"] = json!({"definitionId":"owned-workflow","version":1});
    let definition: OfficeAssistantDefinition = serde_json::from_value(value).unwrap();
    assert!(office_tool_ceiling(&definition).is_err());
}

fn stored_snapshot() -> (
    Fixture,
    ConnectionState,
    OriginalCaller,
    kcoder_config::PrivateDirectory,
) {
    let fixture = Fixture::new();
    let (state, request) = source(&fixture);
    let owner = IntegrationOwner::from(fixture.context.scope());
    let (_, store) = NativeDomainGuard::initialize(
        fixture.context.profile().unwrap(),
        fixture.context.scope(),
        NativeDomain::Office,
        "snapshot-busy-fixture",
        |directory| OfficeStore::create_in(directory, OsStr::new("data"), owner.clone()),
    )
    .unwrap();
    let definition = kcoder_config::integrations::office::builtin_office_assistant(
        "builtin.office-task",
        "zh-CN",
    )
    .unwrap();
    let inputs = kcoder_config::integrations::office::prepare_office_inputs(
        &definition,
        &request.payload["inputs"],
    )
    .unwrap();
    let version = OfficeAssistantVersion {
        owner,
        version: "2".into(),
        definition_sha256: digest(&serde_json::to_vec(&definition).unwrap()),
        definition,
        created_at_ms: 1,
        archived: false,
    };
    store
        .adopt_snapshot(
            &adoption_operation(&request).unwrap(),
            request.scope.clone(),
            version,
            inputs,
            1,
        )
        .unwrap();
    let caller = OriginalCaller::capture(
        &state,
        kcoder_app_protocol::integrations::office::OfficeMethod::AdoptAssistant,
        &request,
    )
    .unwrap();
    let guard = NativeDomainGuard::observe(
        fixture.context.profile().unwrap(),
        fixture.context.scope(),
        NativeDomain::Office,
    )
    .unwrap()
    .unwrap();
    let namespace = guard.directory(fixture.context.profile().unwrap()).unwrap();
    let data = namespace
        .open_entry_handle(OsStr::new("data"))
        .unwrap()
        .open_child_directory()
        .unwrap();
    (fixture, state, caller, data)
}
fn hold_original_store_writer(
    data: &kcoder_config::PrivateDirectory,
) -> kcoder_config::VerifiedPrivateLease {
    let file = data
        .open_single_link_regular_file(OsStr::new("office-header.json"))
        .unwrap();
    let header: Value = serde_json::from_reader(file).unwrap();
    let identity: kcoder_config::PortableLeaseIdentity =
        serde_json::from_value(header["lockIdentity"].clone()).unwrap();
    data.try_existing_portable_lock(
        OsStr::new("office-state.lock"),
        &identity,
        kcoder_config::PrivateLeaseMode::Exclusive,
    )
    .unwrap()
    .unwrap()
}
#[test]
fn readonly_snapshot_waits_for_the_real_verified_store_writer_without_changing_the_snapshot() {
    let (_fixture, _state, caller, data) = stored_snapshot();
    let before = caller.snapshot().unwrap();
    let writer = hold_original_store_writer(&data);
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(writer);
    });
    assert_eq!(caller.snapshot().unwrap(), before);
    release.join().unwrap();
}
#[tokio::test]
async fn permanent_real_store_busy_is_bounded_and_owner_or_cancel_is_never_retried() {
    let (_fixture, state, caller, data) = stored_snapshot();
    let _writer = hold_original_store_writer(&data);
    let cancel = CancellationToken::new();
    let start = Instant::now();
    let error = caller.snapshot_async(&cancel).await.unwrap_err();
    assert!(exact_store_busy(&error));
    assert!(start.elapsed() >= std::time::Duration::from_millis(900));
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    state.input_ended.cancel();
    let start = Instant::now();
    assert!(!exact_store_busy(&caller.snapshot().unwrap_err()));
    assert!(start.elapsed() < std::time::Duration::from_millis(100));
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert_eq!(
        caller
            .snapshot_async(&cancelled)
            .await
            .unwrap_err()
            .to_string(),
        "OFFICE_CANCELLED"
    );
}
#[tokio::test]
async fn owner_revocation_interrupts_async_busy_wait_before_writer_releases() {
    let (_fixture, state, caller, data) = stored_snapshot();
    let _writer = hold_original_store_writer(&data);
    let ended = state.input_ended.clone();
    let revoke = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        ended.cancel();
    });
    let start = Instant::now();
    let error = caller
        .snapshot_async(&CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "OFFICE_MANAGEMENT_OWNER_ENDED");
    assert!(start.elapsed() < std::time::Duration::from_millis(300));
    revoke.await.unwrap();
}
