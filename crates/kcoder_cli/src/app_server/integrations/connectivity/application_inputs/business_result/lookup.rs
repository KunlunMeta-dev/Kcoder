//! A platform lookup returns an observed object, never an invented write response.
use super::*;
use kcoder_integration_storage::integrations::office::{
    OfficeApplicationEffectIntent, OfficeApplicationReconciliationProof,
};

pub fn verify(
    action: McpApplicationAction,
    original: &OfficeApplicationEffectIntent,
    result: &Value,
) -> Result<(VerifiedBusinessResult, OfficeApplicationReconciliationProof)> {
    original.validate()?;
    ensure!(
        action.reconciles_effect() == Some(original.rule.action)
            && id(result, "operationId")? == original.root_operation_id
            && id(result, "state")? == "found",
        "APPLICATION_BUSINESS_LOOKUP_ORIGINAL_REQUIRED"
    );
    let object = result
        .get("object")
        .filter(|value| value.is_object())
        .context("APPLICATION_BUSINESS_LOOKUP_OBJECT_REQUIRED")?;
    ensure!(
        id(object, "operationId")? == original.root_operation_id,
        "APPLICATION_BUSINESS_LOOKUP_ORIGINAL_REQUIRED"
    );
    let mut verified = VerifiedBusinessResult {
        bytes: serde_json::to_vec(result)?,
        format: OfficeFileFormat::Json,
        kind: OfficeArtifactKind::OperationReceipt,
        receipt_id: None,
        filename: None,
    };
    ensure!(
        verified.bytes.len() <= 65536,
        "APPLICATION_BUSINESS_RESULT_LIMIT"
    );
    let input = &original.approved_input;
    let object_id = match action {
        McpApplicationAction::DocumentLookup => {
            ensure!(
                id(object, "state")? == "created",
                "APPLICATION_BUSINESS_LOOKUP_OBJECT_REQUIRED"
            );
            equal_text(input, object, "title")?;
            equal_text(input, object, "body")?;
            ensure!(
                text(object, "bodySha256")? == hash(text(input, "body")?.as_bytes()),
                "APPLICATION_BUSINESS_LOOKUP_CONTENT_CHANGED"
            );
            id(object, "documentId")?
        }
        McpApplicationAction::MailLookup => {
            ensure!(
                id(object, "state")? == "sent",
                "APPLICATION_BUSINESS_LOOKUP_OBJECT_REQUIRED"
            );
            equal_text(input, object, "to")?;
            equal_text(input, object, "subject")?;
            ensure!(
                text(object, "bodySha256")? == hash(text(input, "body")?.as_bytes()),
                "APPLICATION_BUSINESS_LOOKUP_CONTENT_CHANGED"
            );
            id(object, "messageId")?
        }
        McpApplicationAction::TableLookup => {
            ensure!(
                id(object, "state")? == "exported" && id(object, "mimeType")? == "text/csv",
                "APPLICATION_BUSINESS_LOOKUP_OBJECT_REQUIRED"
            );
            let expected = bounded_rows(input, object)?;
            verified.bytes = bytes(object)?;
            ensure!(
                csv::read(&verified.bytes)? == expected,
                "APPLICATION_BUSINESS_CSV_ROWS_CHANGED"
            );
            verified.format = OfficeFileFormat::Csv;
            id(object, "exportId")?
        }
        _ => anyhow::bail!("APPLICATION_BUSINESS_LOOKUP_ACTION_REQUIRED"),
    };
    verified.receipt_id = Some(object_id.into());
    let proof = OfficeApplicationReconciliationProof {
        original_effect_operation_id: original.effect_operation_id.clone(),
        original_intent_sha256: hash(&serde_json::to_vec(original)?),
        observed_object_id: object_id.into(),
        observed_object_sha256: hash(&serde_json::to_vec(object)?),
    };
    Ok((verified, proof))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn original() -> OfficeApplicationEffectIntent {
        let input = json!({"resourceUri":"owned://selected","operationId":"original","title":"Approved title","body":"Approved complete body"});
        serde_json::from_value(json!({
            "version":1,"owner":{"accountId":"owned","targetId":"target","workspaceId":"workspace"},
            "task":{"threadId":"original-thread","turnId":"original-turn"},
            "rootOperationId":"original","effectOperationId":"original-effect","nativeCallId":"original-approved-call",
            "businessAction":"document.create","toolName":"original-create","rawToolName":"create","server":"owned-source","pluginId":null,
            "source":{"sourceRef":{"id":"source","revision":"birth"},"accountRef":null},
            "connection":{"id":"owned-connection","revision":"3"},"resources":[{"id":"owned-resource","revision":"1","kind":"document"}],
            "resourceUris":["owned://selected"],"rule":{"action":"document.create","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/resourceUri","operation_id_input_pointer":"/operationId","input_template":{"resourceUri":null,"operationId":null,"title":null,"body":null},"fields":{"/title":{"type":"string","max_bytes":256},"/body":{"type":"string","max_bytes":256}}},
            "approvedInput":input,"inputSha256":hash(&serde_json::to_vec(&input).unwrap()),
        })).unwrap()
    }
    #[test]
    fn original_object_lookup_checks_saved_approval_content_and_keeps_lookup_provenance() {
        let original = original();
        let found = json!({"operationId":"original","state":"found","object":{"operationId":"original","state":"created","documentId":"actual-platform-object","title":"Approved title","body":"Approved complete body","bodySha256":hash(b"Approved complete body")}});
        let (verified, proof) =
            verify(McpApplicationAction::DocumentLookup, &original, &found).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&verified.bytes).unwrap(),
            found
        );
        assert_eq!(
            proof.original_effect_operation_id,
            original.effect_operation_id
        );
        assert_eq!(
            proof.original_intent_sha256,
            hash(&serde_json::to_vec(&original).unwrap())
        );
        assert_eq!(proof.observed_object_id, "actual-platform-object");
        for (key, value) in [
            ("operationId", json!("other")),
            ("documentId", json!("")),
            ("title", json!("Changed title")),
            ("body", json!("Truncated")),
            ("bodySha256", json!("0".repeat(64))),
        ] {
            let mut wrong = found.clone();
            wrong["object"][key] = value;
            assert!(verify(McpApplicationAction::DocumentLookup, &original, &wrong).is_err());
        }
        let mut missing = found.clone();
        missing["state"] = json!("not_found");
        assert!(verify(McpApplicationAction::DocumentLookup, &original, &missing).is_err());
        assert!(verify(McpApplicationAction::MailLookup, &original, &found).is_err());
        assert!(
            super::super::verify(
                McpApplicationAction::DocumentLookup,
                "original",
                &json!({"operationId":"original"}),
                &found
            )
            .is_err()
        );
    }
    #[test]
    fn mail_and_export_lookup_validate_the_original_recipient_bounds_and_saved_bytes() {
        let mut intent = original();
        for (lookup, effect, task, input, object, changed_key) in [
            (
                McpApplicationAction::MailLookup,
                McpApplicationAction::MailSend,
                "mail.send",
                json!({"resourceUri":"owned://selected","operationId":"original","to":"owned@example.invalid","subject":"Approved","body":"Approved complete body"}),
                json!({"operationId":"original","state":"sent","messageId":"actual-message","to":"owned@example.invalid","subject":"Approved","bodySha256":hash(b"Approved complete body")}),
                "to",
            ),
            (
                McpApplicationAction::TableLookup,
                McpApplicationAction::TableExport,
                "table.export",
                json!({"resourceUri":"owned://selected","operationId":"original","limit":1,"region":"east"}),
                json!({"operationId":"original","state":"exported","exportId":"actual-export","mimeType":"text/csv","limit":1,"region":"east","columns":["id","region","units"],"rows":[{"id":"row","region":"east","units":37}],"rowCount":1,"base64":STANDARD.encode(b"id,region,units\nrow,east,37\n"),"bytes":28,"sha256":hash(b"id,region,units\nrow,east,37\n")}),
                "region",
            ),
        ] {
            intent.business_action = task.into();
            intent.approved_input = input.clone();
            intent.input_sha256 = hash(&serde_json::to_vec(&input).unwrap());
            intent.rule.action = effect;
            let mut template = input.clone();
            let mut fields = std::collections::BTreeMap::new();
            for (key, value) in template.as_object_mut().unwrap() {
                let field = if value.is_number() {
                    kcoder_types::McpApplicationInputField::Integer {
                        minimum: 1,
                        maximum: 100,
                    }
                } else {
                    kcoder_types::McpApplicationInputField::String {
                        max_bytes: 256,
                        allowed_values: vec![],
                    }
                };
                *value = Value::Null;
                if !matches!(key.as_str(), "resourceUri" | "operationId") {
                    fields.insert(format!("/{key}"), field);
                }
            }
            intent.rule.input_template = template;
            intent.rule.fields = fields;
            let mut found = json!({"operationId":"original","state":"found","object":object});
            if lookup == McpApplicationAction::TableLookup {
                found["object"]["bytes"] = json!(b"id,region,units\nrow,east,37\n".len());
            }
            let (verified, _) = verify(lookup, &intent, &found).unwrap();
            if lookup == McpApplicationAction::TableLookup {
                assert_eq!(verified.bytes, b"id,region,units\nrow,east,37\n");
            }
            let mut wrong = found.clone();
            wrong["object"][changed_key] = json!("foreign");
            assert!(verify(lookup, &intent, &wrong).is_err());
            if lookup == McpApplicationAction::TableLookup {
                let bad = b"id,region,units\nrow,east,99\n";
                found["object"]["base64"] = json!(STANDARD.encode(bad));
                found["object"]["sha256"] = json!(hash(bad));
                found["object"]["bytes"] = json!(bad.len());
                assert!(verify(lookup, &intent, &found).is_err());
            }
        }
    }
}
