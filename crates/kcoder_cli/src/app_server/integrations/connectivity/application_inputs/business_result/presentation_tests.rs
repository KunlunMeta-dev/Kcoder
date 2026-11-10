//! Recorded platform states must pass the original Native Office publisher.
use super::*;
use crate::app_server::integrations::office::native_host::NativeOfficeComposition;
use kcoder_state::{
    integrations::office::OfficeApplicationToolReceipt,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};

#[test]
fn confirmed_platform_effect_states_publish_as_native_completed_receipts() -> Result<()> {
    let fixture =
        crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
    let engine = crate::app_server::tests::catalog_list_test_engine(&fixture.workspace)
        .with_settings_persistence_path(fixture.profile.join("settings.json"));
    engine.settings.write().unwrap().integrations.office.enabled = true;
    let task = OfficeTaskRef {
        thread_id: engine.session_id(),
        turn_id: "recorded-effect-turn".into(),
        run_id: None,
    };
    TurnAttemptStore::open(
        &engine.session_storage_dir_for(&task.thread_id),
        &task.thread_id,
    )?
    .begin(TurnAttemptRecord {
        client_presentation: None,
        version: 1,
        identity: TurnAttemptIdentity {
            thread_id: task.thread_id.clone(),
            turn_id: task.turn_id.clone(),
            attempt_id: "recorded-effect-attempt".into(),
        },
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    let office = NativeOfficeComposition::initialize_metadata(
        &fixture.context,
        &engine,
        Default::default(),
        "recorded-publisher-setup",
    )?;
    for (action, label, input, actual) in [
        (
            McpApplicationAction::DocumentCreate,
            "document",
            json!({"resourceUri":"owned-application://document/original","operationId":"original","title":"Owned review","body":"Owned approved document: 37 units."}),
            json!({"operationId":"original","documentId":"doc-868a50e738801048","title":"Owned review","body":"Owned approved document: 37 units.","bodySha256":"979d7d6b784ac3aff92b494c0c31623faee7c15b89dad2eb46e64793d057863e","state":"created"}),
        ),
        (
            McpApplicationAction::MailSend,
            "mail",
            json!({"resourceUri":"owned-application://mailbox/original","operationId":"original","to":"owned-recipient@example.invalid","subject":"Owned review","body":"Owned approved send: 37 units."}),
            json!({"operationId":"original","messageId":"owned-message","to":"owned-recipient@example.invalid","subject":"Owned review","bodySha256":hash(b"Owned approved send: 37 units."),"state":"sent"}),
        ),
    ] {
        let verified = verify(action, "original", &input, &actual)?;
        let mut template = input.clone();
        let mut fields = serde_json::Map::new();
        for (key, value) in template.as_object_mut().unwrap() {
            *value = Value::Null;
            if !matches!(key.as_str(), "resourceUri" | "operationId") {
                fields.insert(format!("/{key}"), json!({"type":"string","max_bytes":256}));
            }
        }
        let mut rule: McpApplicationActionRule = serde_json::from_value(
            json!({"action":"document.create","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/resourceUri","operation_id_input_pointer":"/operationId","input_template":template,"fields":fields}),
        )?;
        rule.action = action;
        let task_action = if action == McpApplicationAction::DocumentCreate {
            "document.create"
        } else {
            "mail.send"
        };
        assert!(
            rule.resource_uri(&"a".repeat(64), task_action, "original", &input)
                .is_some()
        );
        let receipt: OfficeApplicationToolReceipt = serde_json::from_value(json!({
            "version":1,"owner":IntegrationOwner::from(fixture.context.scope()),"task":task,
            "artifact":{"id":format!("recorded-{label}"),"revision":1},
            "rootOperationId":"original","effectOperationId":format!("original-{label}-effect"),
            "nativeCallId":format!("recorded-{label}-call"),"toolName":format!("mcp-owned-{label}"),"rawToolName":label,
            "server":"owned-registered-source","pluginId":null,
            "source":{"sourceRef":{"id":"owned-source","revision":"owned-birth"},"accountRef":null},
            "connection":{"id":"owned-connection","revision":"3"},
            "resources":[{"id":"owned-resource","revision":"1","kind":label}],
            "rule":rule,"approvedInput":input,"inputSha256":hash(&serde_json::to_vec(&input)?),
            "actualResult":actual,"resultSha256":hash(&serde_json::to_vec(&actual)?),
            "contentSha256":hash(verified.bytes()),"byteContentSha256":actual["bodySha256"].as_str(),
        }))?;
        let manifest = office.publish_native_application_result(
            &fixture.context,
            &task,
            &format!("publish-recorded-{label}"),
            receipt,
            verified,
            &actual,
            None,
        )?;
        manifest.validate()?;
        assert!(
            matches!(manifest.presentation, Some(OfficeArtifactPresentation::OperationReceipt { phase, .. }) if phase == "completed")
        );
        assert_eq!(
            manifest
                .verification
                .pending_checks
                .contains(&"saved_document_readback".into()),
            action == McpApplicationAction::DocumentCreate
        );
    }
    Ok(())
}
