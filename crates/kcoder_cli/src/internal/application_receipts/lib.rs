//! Pure validation of original application results and reconciliation observations.

use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_types::{
    McpApplicationAction,
    integrations::office::{OfficeArtifactKind, OfficeFileFormat},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "../../app_server/integrations/connectivity/application_inputs/business_result/csv.rs"]
mod csv;
#[path = "../../app_server/integrations/connectivity/application_inputs/business_result/lookup.rs"]
pub mod lookup;

pub struct VerifiedBusinessResult {
    bytes: Vec<u8>,
    format: OfficeFileFormat,
    kind: OfficeArtifactKind,
    receipt_id: Option<String>,
    filename: Option<String>,
}
impl VerifiedBusinessResult {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn format(&self) -> OfficeFileFormat {
        self.format
    }

    pub fn kind(&self) -> OfficeArtifactKind {
        self.kind
    }

    pub fn receipt_id(&self) -> Option<&str> {
        self.receipt_id.as_deref()
    }

    pub fn filename(&self) -> Option<&str> {
        self.filename.as_deref()
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= 65536)
        .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")
}
fn id<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let value = text(value, key)?;
    ensure!(
        !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "APPLICATION_BUSINESS_RESULT_UNCONFIRMED"
    );
    Ok(value)
}
fn equal_text(input: &Value, result: &Value, key: &str) -> Result<()> {
    ensure!(
        text(input, key)? == text(result, key)?,
        "APPLICATION_BUSINESS_RESULT_TARGET_CHANGED"
    );
    Ok(())
}
pub fn verify_input(action: McpApplicationAction, operation: &str, input: &Value) -> Result<()> {
    ensure!(input.is_object(), "APPLICATION_BUSINESS_INPUT_DENIED");
    if action.requires_operation_id() {
        ensure!(
            !operation.is_empty() && id(input, "operationId")? == operation,
            "APPLICATION_BUSINESS_ORIGINAL_OPERATION_REQUIRED"
        );
    }
    match action {
        McpApplicationAction::DocumentLookup
        | McpApplicationAction::MailLookup
        | McpApplicationAction::TableLookup => {}
        McpApplicationAction::DocumentRead => {
            id(input, "documentId")?;
        }
        McpApplicationAction::DocumentCreate => {
            text(input, "title")?;
            text(input, "body")?;
        }
        McpApplicationAction::MailList => {
            bounded_limit(input)?;
        }
        McpApplicationAction::MailRead => {
            id(input, "messageId")?;
        }
        McpApplicationAction::MailAttachment => {
            id(input, "messageId")?;
            id(input, "attachmentId")?;
        }
        McpApplicationAction::MailSend => {
            id(input, "to")?;
            id(input, "subject")?;
            text(input, "body")?;
        }
        McpApplicationAction::TableQuery | McpApplicationAction::TableExport => {
            bounded_limit(input)?;
            id(input, "region")?;
        }
    }
    Ok(())
}
fn bounded_limit(input: &Value) -> Result<u64> {
    input
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|limit| (1..=100).contains(limit))
        .context("APPLICATION_BUSINESS_INPUT_BOUND_REQUIRED")
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn bounded_rows(input: &Value, result: &Value) -> Result<Vec<Vec<String>>> {
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|limit| (1..=100).contains(limit))
        .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
    let region = id(input, "region")?;
    ensure!(
        id(result, "region")? == region
            && result.get("limit").and_then(Value::as_u64) == Some(limit),
        "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
    );
    let rows = result
        .get("rows")
        .and_then(Value::as_array)
        .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
    let columns = result
        .get("columns")
        .and_then(Value::as_array)
        .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
    ensure!(
        !columns.is_empty()
            && columns.len() <= 32
            && rows.len() as u64 <= limit
            && result.get("rowCount").and_then(Value::as_u64) == Some(rows.len() as u64),
        "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
    );
    let columns = columns
        .iter()
        .map(|column| {
            column
                .as_str()
                .filter(|key| {
                    !key.trim().is_empty() && key.len() <= 128 && !key.chars().any(char::is_control)
                })
                .map(str::to_owned)
                .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        columns
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == columns.len(),
        "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
    );
    let mut records = vec![columns.clone()];
    for row in rows {
        let object = row
            .as_object()
            .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
        ensure!(
            object.len() == columns.len() && columns.iter().all(|key| object.contains_key(key)),
            "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
        );
        if region != "all" {
            ensure!(
                id(row, "region")? == region,
                "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
            );
        }
        let mut cells = Vec::new();
        for column in &columns {
            let value = &object[column];
            let cell = match value {
                Value::Null => String::new(),
                Value::Number(value) => value.to_string(),
                Value::Bool(value) => value.to_string(),
                Value::String(value) => {
                    ensure!(
                        value.len() <= 65536
                            && !value.trim_start().starts_with(['=', '+', '-', '@']),
                        "APPLICATION_BUSINESS_CSV_UNSAFE_CELL"
                    );
                    value.clone()
                }
                _ => anyhow::bail!("APPLICATION_BUSINESS_RESULT_UNCONFIRMED"),
            };
            cells.push(cell);
        }
        records.push(cells);
    }
    Ok(records)
}
fn bytes(result: &Value) -> Result<Vec<u8>> {
    let decoded = STANDARD
        .decode(text(result, "base64")?)
        .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
    ensure!(
        decoded.len() <= 65536
            && result.get("bytes").and_then(Value::as_u64) == Some(decoded.len() as u64)
            && text(result, "sha256")? == hash(&decoded),
        "APPLICATION_BUSINESS_RESULT_BYTES_CHANGED"
    );
    Ok(decoded)
}
pub fn verify(
    action: McpApplicationAction,
    operation: &str,
    input: &Value,
    result: &Value,
) -> Result<VerifiedBusinessResult> {
    ensure!(
        input.is_object() && result.is_object(),
        "APPLICATION_BUSINESS_RESULT_UNCONFIRMED"
    );
    let mut verified = VerifiedBusinessResult {
        bytes: serde_json::to_vec(result)?,
        format: OfficeFileFormat::Json,
        kind: OfficeArtifactKind::Document,
        receipt_id: None,
        filename: None,
    };
    ensure!(
        verified.bytes.len() <= 65536,
        "APPLICATION_BUSINESS_RESULT_LIMIT"
    );
    if action.is_effect() {
        ensure!(
            !operation.is_empty()
                && id(input, "operationId")? == operation
                && id(result, "operationId")? == operation,
            "APPLICATION_BUSINESS_ORIGINAL_RECEIPT_REQUIRED"
        );
        verified.kind = OfficeArtifactKind::OperationReceipt;
    }
    match action {
        McpApplicationAction::DocumentLookup
        | McpApplicationAction::MailLookup
        | McpApplicationAction::TableLookup => {
            anyhow::bail!("APPLICATION_BUSINESS_LOOKUP_INTENT_REQUIRED")
        }
        McpApplicationAction::DocumentRead => {
            ensure!(
                id(input, "documentId")? == id(result, "documentId")?,
                "APPLICATION_BUSINESS_RESULT_TARGET_CHANGED"
            );
            text(result, "body")?;
        }
        McpApplicationAction::DocumentCreate => {
            verified.receipt_id = Some(id(result, "documentId")?.into());
            equal_text(input, result, "title")?;
            equal_text(input, result, "body")?;
            ensure!(
                id(result, "state")? == "created"
                    && text(result, "bodySha256")? == hash(text(input, "body")?.as_bytes()),
                "APPLICATION_BUSINESS_RESULT_CONTENT_CHANGED"
            );
        }
        McpApplicationAction::MailList => {
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .filter(|limit| (1..=100).contains(limit))
                .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
            let items = result
                .get("items")
                .and_then(Value::as_array)
                .context("APPLICATION_BUSINESS_RESULT_UNCONFIRMED")?;
            ensure!(
                items.len() as u64 <= limit,
                "APPLICATION_BUSINESS_RESULT_BOUND_CHANGED"
            );
            for item in items {
                id(item, "messageId")?;
            }
        }
        McpApplicationAction::MailRead => {
            ensure!(
                id(input, "messageId")? == id(result, "messageId")?,
                "APPLICATION_BUSINESS_RESULT_TARGET_CHANGED"
            );
            text(result, "body")?;
        }
        McpApplicationAction::MailAttachment => {
            ensure!(
                id(input, "messageId")? == id(result, "messageId")?
                    && id(input, "attachmentId")? == id(result, "attachmentId")?,
                "APPLICATION_BUSINESS_RESULT_TARGET_CHANGED"
            );
            let name = id(result, "name")?;
            ensure!(
                name.len() <= 200 && !name.contains(['/', '\\', ':']),
                "APPLICATION_BUSINESS_ATTACHMENT_FORMAT_UNAVAILABLE"
            );
            verified.bytes = bytes(result)?;
            verified.format = match (id(result, "mimeType")?, name.rsplit('.').next()) {
                ("text/csv", Some("csv")) => {
                    csv::read(&verified.bytes)?;
                    OfficeFileFormat::Csv
                }
                ("application/json", Some("json")) => {
                    serde_json::from_slice::<Value>(&verified.bytes)?;
                    OfficeFileFormat::Json
                }
                ("application/pdf", Some("pdf")) => {
                    ensure!(
                        verified.bytes.starts_with(b"%PDF-")
                            && verified.bytes.windows(5).any(|bytes| bytes == b"%%EOF"),
                        "APPLICATION_BUSINESS_ATTACHMENT_FORMAT_UNAVAILABLE"
                    );
                    OfficeFileFormat::Pdf
                }
                _ => anyhow::bail!("APPLICATION_BUSINESS_ATTACHMENT_FORMAT_UNAVAILABLE"),
            };
            verified.filename = Some(name.into());
        }
        McpApplicationAction::MailSend => {
            verified.receipt_id = Some(id(result, "messageId")?.into());
            equal_text(input, result, "to")?;
            equal_text(input, result, "subject")?;
            ensure!(
                id(result, "state")? == "sent"
                    && text(result, "bodySha256")? == hash(text(input, "body")?.as_bytes()),
                "APPLICATION_BUSINESS_RESULT_CONTENT_CHANGED"
            );
        }
        McpApplicationAction::TableQuery => {
            bounded_rows(input, result)?;
            verified.kind = OfficeArtifactKind::Table;
        }
        McpApplicationAction::TableExport => {
            let expected = bounded_rows(input, result)?;
            verified.receipt_id = Some(id(result, "exportId")?.into());
            ensure!(
                id(result, "state")? == "exported" && id(result, "mimeType")? == "text/csv",
                "APPLICATION_BUSINESS_RESULT_UNCONFIRMED"
            );
            verified.bytes = bytes(result)?;
            ensure!(
                csv::read(&verified.bytes)? == expected,
                "APPLICATION_BUSINESS_CSV_ROWS_CHANGED"
            );
            verified.format = OfficeFileFormat::Csv;
            verified.kind = OfficeArtifactKind::Table;
        }
    }
    Ok(verified)
}
pub fn verify_document_readback(
    operation: &str,
    created_input: &Value,
    created_result: &Value,
    read_input: &Value,
    read_result: &Value,
) -> Result<String> {
    ensure!(
        !operation.is_empty()
            && id(created_result, "operationId")? == operation
            && id(read_result, "createdOperationId")? == operation
            && id(created_result, "documentId")? == id(read_input, "documentId")?
            && id(read_input, "documentId")? == id(read_result, "documentId")?,
        "APPLICATION_DOCUMENT_READBACK_IDENTITY_CHANGED"
    );
    ensure!(
        text(created_input, "title")? == text(read_result, "title")?
            && text(created_input, "body")? == text(read_result, "body")?,
        "APPLICATION_DOCUMENT_READBACK_CONTENT_CHANGED"
    );
    Ok(hash(text(read_result, "body")?.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn incompatible_reviewed_input_is_unavailable_before_any_business_io() {
        for action in [
            McpApplicationAction::DocumentRead,
            McpApplicationAction::DocumentCreate,
            McpApplicationAction::MailList,
            McpApplicationAction::MailRead,
            McpApplicationAction::MailAttachment,
            McpApplicationAction::MailSend,
            McpApplicationAction::TableQuery,
            McpApplicationAction::TableExport,
        ] {
            assert!(
                verify_input(
                    action,
                    "original",
                    &json!({"operationId":"original","uri":"owned://selected"})
                )
                .is_err()
            );
        }
        assert!(verify_input(McpApplicationAction::MailSend,"original",&json!({"operationId":"original","to":"owned@example.invalid\nBcc: other@example.invalid","subject":"Reviewed","body":"Approved"})).is_err());
        assert!(
            verify_input(
                McpApplicationAction::TableExport,
                "original",
                &json!({"operationId":"original","limit":101,"region":"east"})
            )
            .is_err()
        );
        assert!(verify_input(McpApplicationAction::DocumentCreate,"original",&json!({"operationId":"original","title":"Owned title","body":"Approved exact body"})).is_ok());
        assert!(verify_input(McpApplicationAction::MailSend,"original",&json!({"operationId":"original","to":"owned@example.invalid","subject":"Reviewed","body":"Approved"})).is_ok());
    }

    #[test]
    fn saved_document_readback_binds_original_object_operation_title_and_complete_body() {
        let created_input = json!({"title":"Approved title","body":"Approved complete body"});
        let created_result = json!({"operationId":"original","documentId":"created-document"});
        let read_input = json!({"documentId":"created-document"});
        let read_result = json!({"documentId":"created-document","createdOperationId":"original","title":"Approved title","body":"Approved complete body"});
        assert_eq!(
            verify_document_readback(
                "original",
                &created_input,
                &created_result,
                &read_input,
                &read_result
            )
            .unwrap(),
            hash(b"Approved complete body")
        );
        for (key, value) in [
            ("documentId", json!("other-document")),
            ("createdOperationId", json!("other-operation")),
            ("title", json!("Other title")),
            ("body", json!("Truncated")),
        ] {
            let mut changed = read_result.clone();
            changed[key] = value;
            assert!(
                verify_document_readback(
                    "original",
                    &created_input,
                    &created_result,
                    &read_input,
                    &changed
                )
                .is_err()
            );
        }
    }
    #[test]
    fn missing_or_null_matching_fields_never_prove_a_document_mail_or_query_result() {
        for action in [
            McpApplicationAction::DocumentRead,
            McpApplicationAction::MailRead,
            McpApplicationAction::MailAttachment,
            McpApplicationAction::TableQuery,
        ] {
            assert!(verify(action, "original", &json!({}), &json!({"body":"present"})).is_err());
            assert!(
                verify(
                    action,
                    "original",
                    &json!({"documentId":null,"messageId":null}),
                    &json!({"documentId":null,"messageId":null,"body":"present"})
                )
                .is_err()
            );
        }
        assert!(verify(McpApplicationAction::MailSend,"original",&json!({"operationId":"original","body":"actual"}),&json!({"operationId":"original","messageId":"sent","state":"sent","bodySha256":hash(b"actual")})).is_err());
        let valid = json!({"limit":1,"region":"east"});
        let result = json!({"limit":1,"region":"east","columns":["region"],"rows":[{"region":"east"}],"rowCount":1});
        assert!(
            verify(
                McpApplicationAction::TableQuery,
                "original",
                &valid,
                &result
            )
            .is_ok()
        );
        for changed in [
            json!({"limit":0,"region":"east"}),
            json!({"limit":101,"region":"east"}),
            json!({"limit":1,"region":null}),
        ] {
            assert!(
                verify(
                    McpApplicationAction::TableQuery,
                    "original",
                    &changed,
                    &result
                )
                .is_err()
            );
        }
    }
    #[test]
    fn attachment_keeps_real_decoded_bytes_and_rejects_missing_ids_or_fake_formats() {
        let raw = b"item,units\nowned,37\n";
        let input = json!({"messageId":"message","attachmentId":"attachment"});
        let result = json!({"messageId":"message","attachmentId":"attachment","name":"owned.csv","mimeType":"text/csv","base64":STANDARD.encode(raw),"bytes":raw.len(),"sha256":hash(raw)});
        let verified = verify(
            McpApplicationAction::MailAttachment,
            "original",
            &input,
            &result,
        )
        .unwrap();
        assert_eq!(verified.bytes, raw);
        assert_eq!(verified.format, OfficeFileFormat::Csv);
        assert_eq!(verified.filename.as_deref(), Some("owned.csv"));
        let mut unsupported = result.clone();
        unsupported["mimeType"] = json!("application/octet-stream");
        assert!(
            verify(
                McpApplicationAction::MailAttachment,
                "original",
                &input,
                &unsupported
            )
            .is_err()
        );
        let mut fake = result.clone();
        fake["name"] = json!("owned.pdf");
        fake["mimeType"] = json!("application/pdf");
        assert!(
            verify(
                McpApplicationAction::MailAttachment,
                "original",
                &input,
                &fake
            )
            .is_err()
        );
        let mut missing = result;
        missing.as_object_mut().unwrap().remove("attachmentId");
        assert!(
            verify(
                McpApplicationAction::MailAttachment,
                "original",
                &input,
                &missing
            )
            .is_err()
        );
    }
    #[test]
    fn a_self_consistent_hash_cannot_hide_an_export_with_different_rows_columns_or_bounds() {
        let input = json!({"operationId":"original","limit":1,"region":"east"});
        let raw = b"id,region,units\nrow-1,east,37\n";
        let result = json!({"operationId":"original","exportId":"export","state":"exported","mimeType":"text/csv",
            "limit":1,"region":"east","columns":["id","region","units"],"rows":[{"id":"row-1","region":"east","units":37}],"rowCount":1,
            "base64":STANDARD.encode(raw),"bytes":raw.len(),"sha256":hash(raw)});
        assert_eq!(
            verify(
                McpApplicationAction::TableExport,
                "original",
                &input,
                &result
            )
            .unwrap()
            .bytes,
            raw
        );
        for wrong in [
            b"id,region,units\nrow-1,east,99\n".as_slice(),
            b"id,units,region\nrow-1,37,east\n".as_slice(),
            b"id,region,units\nrow-1,east,37\nrow-2,east,11\n".as_slice(),
        ] {
            let mut changed = result.clone();
            changed["base64"] = json!(STANDARD.encode(wrong));
            changed["bytes"] = json!(wrong.len());
            changed["sha256"] = json!(hash(wrong));
            assert!(
                verify(
                    McpApplicationAction::TableExport,
                    "original",
                    &input,
                    &changed
                )
                .is_err()
            );
        }
    }
}
