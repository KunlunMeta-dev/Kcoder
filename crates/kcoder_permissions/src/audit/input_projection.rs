//! Bounded audit metadata; original input remains exclusively with permission matching/execution.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;

const MAX_TOOL_BYTES: usize = 256;
const MAX_REASON_BYTES: usize = 128;
const MAX_PROJECTION_BYTES: usize = 8 * 1024;

struct InputDigest {
    hash: Sha256,
    bytes: u64,
}
impl Write for InputDigest {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(u64::try_from(bytes.len()).map_err(std::io::Error::other)?)
            .ok_or_else(|| std::io::Error::other("permission audit input length overflow"))?;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn validate_labels(tool: &str, reason: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !tool.is_empty() && tool.len() <= MAX_TOOL_BYTES && !tool.chars().any(char::is_control),
        "permission audit tool label is invalid or excessive"
    );
    anyhow::ensure!(
        !reason.is_empty()
            && reason.len() <= MAX_REASON_BYTES
            && !reason.chars().any(char::is_control),
        "permission audit reason label is invalid or excessive"
    );
    anyhow::ensure!(
        matches!(
            reason,
            "session_deny_list"
                | "deny_list"
                | "session_rule_deny"
                | "rule_deny"
                | "session_allow_list"
                | "allow_list"
                | "session_rule_allow"
                | "rule_allow"
                | "high_risk_ask"
                | "mode_allow"
                | "mode_deny"
                | "mode_ask"
                | "allow"
                | "deny"
                | "ask"
        ),
        "permission audit reason label is unknown"
    );
    Ok(())
}
pub(super) fn project(input: &Value) -> anyhow::Result<Value> {
    let mut writer = InputDigest {
        hash: Sha256::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, input)?;
    let (kind, members) = match input {
        Value::Null => ("null", None),
        Value::Bool(_) => ("boolean", None),
        Value::Number(_) => ("number", None),
        Value::String(_) => ("string", None),
        Value::Array(values) => ("array", Some(u64::try_from(values.len())?)),
        Value::Object(values) => ("object", Some(u64::try_from(values.len())?)),
    };
    // Do not retain values, key names, paths, environment entries or previews.
    let projection = json!({"projection":"permission-audit-input/v1","encoding":"serde-json-compact/v1",
        "jsonType":kind,"topLevelMembers":members,"encodedBytes":writer.bytes,"sha256":format!("{:x}",writer.hash.finalize())});
    anyhow::ensure!(
        serde_json::to_vec(&projection)?.len() <= MAX_PROJECTION_BYTES,
        "permission audit projection exceeds metadata limit"
    );
    Ok(projection)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_complete_unicode_content_is_hashed_without_retaining_values_or_keys() {
        let input = json!({"private-title":{"secret":"PRIVATE_SECRET_SENTINEL","path":"/private/member/body","env":{"PRIVATE_ENV":"sensitive"}},"body":"汉字🙂".repeat(50_000)});
        let before = input.clone();
        let projected = project(&input).unwrap();
        let encoded = serde_json::to_vec(&input).unwrap();
        assert_eq!(input, before);
        assert_eq!(
            projected["sha256"],
            format!("{:x}", Sha256::digest(&encoded))
        );
        assert_eq!(projected["encodedBytes"], encoded.len());
        let log = projected.to_string();
        for sentinel in [
            "PRIVATE_SECRET_SENTINEL",
            "/private/member/body",
            "PRIVATE_ENV",
            "private-title",
            "汉字",
            "sensitive",
        ] {
            assert!(!log.contains(sentinel));
        }
        assert!(log.len() < 512);
        let mut changed = input;
        changed["private-title"]["secret"] = json!("different");
        assert_ne!(project(&changed).unwrap()["sha256"], projected["sha256"]);
    }
    #[test]
    fn labels_are_kept_exact_or_rejected_and_never_silently_truncated() {
        validate_labels("OfficeDocument", "mode_allow").unwrap();
        for bad in [
            "".to_owned(),
            "x".repeat(MAX_REASON_BYTES + 1),
            "allow\ndeny".to_owned(),
        ] {
            assert!(validate_labels("read", &bad).is_err());
        }
        assert!(validate_labels(&"x".repeat(MAX_TOOL_BYTES + 1), "mode_allow").is_err());
        assert!(validate_labels("read", "SECRET_VALUE_USED_AS_REASON").is_err());
    }
}

#[cfg(test)]
mod durable_tests {
    use super::*;
    use crate::{AuditRecord, PermissionAudit};
    #[test]
    fn original_460_kib_input_has_one_small_durable_record_and_legacy_records_remain_readable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("permissions.log");
        let audit = PermissionAudit::new(path.clone());
        let input = json!({"document":{"text":"Source office content 汉字🙂".repeat(22_000)},"env":{"token":"ENV_VALUE_SENTINEL"},"credentials":{"password":"PASSWORD_VALUE_SENTINEL"}});
        let original = serde_json::to_vec(&input).unwrap();
        assert!(original.len() > 460 * 1024);
        audit
            .record("OfficeDocument", &input, "mode_allow")
            .unwrap();
        audit.flush().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() < 8 * 1024);
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), 1);
        for secret in [
            "ENV_VALUE_SENTINEL",
            "PASSWORD_VALUE_SENTINEL",
            "Source office content",
            "credentials",
            "document",
        ] {
            assert!(!text.contains(secret));
        }
        let record: AuditRecord = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(
            record.input["sha256"],
            format!("{:x}", Sha256::digest(&original))
        );
        assert_eq!(record.input["encodedBytes"], original.len());
        let old:AuditRecord=serde_json::from_value(json!({"timestamp_ms":1,"tool_name":"read","input":{"file_path":"legacy"},"reason":"mode_allow"})).unwrap();
        assert_eq!(old.input["file_path"], "legacy");
    }
    #[test]
    fn deeply_nested_and_small_inputs_also_never_persist_original_strings() {
        let mut input = json!("NESTED_PRIVATE_SENTINEL");
        for _ in 0..100 {
            input = json!([input]);
        }
        let summary = project(&input).unwrap();
        assert!(!summary.to_string().contains("NESTED_PRIVATE_SENTINEL"));
        assert_eq!(
            summary["sha256"],
            format!("{:x}", Sha256::digest(serde_json::to_vec(&input).unwrap()))
        );
        assert!(
            !project(&json!({"path":"PRIVATE_PATH_SENTINEL"}))
                .unwrap()
                .to_string()
                .contains("PRIVATE_PATH_SENTINEL")
        );
    }
}
