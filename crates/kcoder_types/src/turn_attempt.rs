use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MAX_STATUS_UTF8_BYTES: usize = 256;

/// One execution attempt of a logical turn. Shared by recovery and model snapshots.
/// The server chooses attempt_id; credentials are never part of this identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttemptIdentity {
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
}
impl TurnAttemptIdentity {
    pub fn validate(&self) -> Result<(), &'static str> {
        if [&self.thread_id, &self.turn_id, &self.attempt_id]
            .into_iter()
            .any(|value| value.trim().is_empty() || value.len() > 256)
        {
            return Err("attempt identity components must contain 1..=256 bytes");
        }
        Ok(())
    }
}

/// Same-schema future statuses are readable facts only. They grant neither
/// terminal evidence nor permission to continue an execution attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnAttemptStatus {
    Accepted,
    Completed,
    Failed,
    Interrupted,
    Unknown(String),
}
impl TurnAttemptStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Accepted => "accepted",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Unknown(raw) => raw,
        }
    }
    pub fn is_known(&self) -> bool {
        !matches!(self, Self::Unknown(_))
    }
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Interrupted)
    }
}
impl Serialize for TurnAttemptStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for TurnAttemptStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw.len() > MAX_STATUS_UTF8_BYTES {
            return Err(serde::de::Error::custom(
                "turn attempt status exceeds 256 UTF-8 bytes",
            ));
        }
        Ok(match raw.as_str() {
            "accepted" => Self::Accepted,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "interrupted" => Self::Interrupted,
            _ => Self::Unknown(raw),
        })
    }
}

/// Server-derived retained input bound to one durable Accepted attempt record.
/// This is evidence, not authority: the caller must verify the current trusted
/// workspace owner and the actual artifact handles before using it as proof.
/// The canonical request digest is the containing record's request_fingerprint;
/// it is deliberately distinct from that record's input_context_hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnRetainedInputV1 {
    pub version: u8,
    pub scope_id: String,
    pub client_message_id: String,
    pub artifacts: Vec<TurnRetainedArtifactV1>,
}

/// Exact reservation reference and materialized artifact facts. No original
/// source path, profile, token or client-provided trusted context is persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnRetainedArtifactV1 {
    pub retention_id: String,
    pub expected_receipt_revision: u64,
    pub root_namespace: String,
    pub epoch: u64,
    pub owner_id: String,
    pub entry_id: String,
    pub entry_revision: u64,
    /// Server-chosen single leaf within the verified artifact parent.
    pub artifact_name: String,
    pub artifact_parent_identity: crate::PrivateFileIdentityV1,
    pub artifact_identity: crate::PrivateFileIdentityV1,
    pub artifact_sha256: String,
    pub artifact_size: u64,
}

impl TurnRetainedInputV1 {
    /// I/O-free shape validation. It cannot prove a file or an authorization.
    pub fn validate(&self) -> Result<(), &'static str> {
        use crate::{PrivateFileIdentityV1, PrivateFileKind};
        use std::collections::{BTreeMap, BTreeSet};
        fn atom(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 256
                && value.trim() == value
                && !value.chars().any(char::is_control)
        }
        fn digest(value: &str) -> bool {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        fn retention_id_matches(id: &str, namespace: &str, epoch: u64) -> bool {
            let parts: Vec<_> = id.split('.').collect();
            parts.len() == 4
                && parts[0] == "r1"
                && parts[1] == namespace
                && epoch > 0
                && parts[2] == epoch.to_string()
                && parts[3].len() == 32
                && parts[3].bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        if self.version != 1
            || !digest(&self.scope_id)
            || !atom(&self.client_message_id)
            || self.artifacts.is_empty()
            || self.artifacts.len() > 32
        {
            return Err("invalid retained attempt binding");
        }
        let mut entries = BTreeSet::new();
        let mut receipts = BTreeMap::new();
        let mut previous = None;
        let mut total = 0u64;
        for (index, item) in self.artifacts.iter().enumerate() {
            if ![
                &item.retention_id,
                &item.root_namespace,
                &item.owner_id,
                &item.entry_id,
            ]
            .into_iter()
            .all(|value| atom(value))
                || !retention_id_matches(&item.retention_id, &item.root_namespace, item.epoch)
                || item.epoch == 0
                || item.expected_receipt_revision == 0
                || item.entry_revision == 0
                || !digest(&item.artifact_sha256)
                || item.artifact_name.is_empty()
                || item.artifact_name.len() > 256
                || !item
                    .artifact_name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                || matches!(item.artifact_name.as_str(), "." | "..")
                || item.artifact_parent_identity.version != PrivateFileIdentityV1::VERSION
                || item.artifact_parent_identity.kind != PrivateFileKind::Directory
                || item.artifact_identity.version != PrivateFileIdentityV1::VERSION
                || item.artifact_identity.kind != PrivateFileKind::RegularFile
            {
                return Err("invalid retained artifact binding");
            }
            let key = (
                &item.retention_id,
                &item.root_namespace,
                item.epoch,
                &item.owner_id,
                &item.entry_id,
            );
            if previous.as_ref().is_some_and(|old| old >= &key) {
                return Err("retained artifact bindings must be canonically ordered");
            }
            previous = Some(key);
            if !entries.insert((
                &item.root_namespace,
                item.epoch,
                &item.owner_id,
                &item.entry_id,
            )) {
                return Err("retained entry appears in multiple reservations");
            }
            if receipts
                .insert(&item.retention_id, item.expected_receipt_revision)
                .is_some_and(|revision| revision != item.expected_receipt_revision)
            {
                return Err("retained reservation revision conflicts");
            }
            if self.artifacts[..index].iter().any(|old| {
                old.artifact_parent_identity == item.artifact_parent_identity
                    && old.artifact_name == item.artifact_name
            }) {
                return Err("retained artifact leaf was reused");
            }
            total = total
                .checked_add(item.artifact_size)
                .ok_or("retained artifact size overflow")?;
            if total > 100 * 1024 * 1024 {
                return Err("retained artifact batch exceeds service byte bound");
            }
        }
        Ok(())
    }
}

// Keep future wire facts readable. Known labels describe executable states;
// they do not form a closed enum for history from a newer implementation.
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for TurnAttemptStatus {
    fn schema_name() -> String {
        "TurnAttemptStatus".into()
    }

    fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
        if let schemars::schema::Schema::Object(object) = &mut schema {
            object.extensions.insert(
                "x-max-utf8-bytes".into(),
                serde_json::json!(MAX_STATUS_UTF8_BYTES),
            );
            object.extensions.insert(
                "x-known-values".into(),
                serde_json::json!([
                    Self::Accepted,
                    Self::Completed,
                    Self::Failed,
                    Self::Interrupted,
                ]),
            );
        }
        schema
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn retained_binding() -> TurnRetainedInputV1 {
        use crate::{PrivateFileIdentityV1, PrivateFileKind, PrivateNativeFileIdentity};
        let identity = |kind, inode| PrivateFileIdentityV1 {
            version: 1,
            kind,
            native: PrivateNativeFileIdentity::Linux { device: 42, inode },
        };
        TurnRetainedInputV1 {
            version: 1,
            scope_id: "a".repeat(64),
            client_message_id: "message".into(),
            artifacts: vec![TurnRetainedArtifactV1 {
                retention_id: "r1.root.1.0123456789abcdef0123456789abcdef".into(),
                expected_receipt_revision: 1,
                root_namespace: "root".into(),
                epoch: 1,
                owner_id: "owner".into(),
                entry_id: "entry-a".into(),
                entry_revision: 1,
                artifact_name: "entry-a.bytes".into(),
                artifact_parent_identity: identity(PrivateFileKind::Directory, 5),
                artifact_identity: identity(PrivateFileKind::RegularFile, 6),
                artifact_sha256: "b".repeat(64),
                artifact_size: 0,
            }],
        }
    }
    #[test]
    fn retained_attempt_contract_is_bounded_strict_and_does_not_contain_authority() {
        let binding = retained_binding();
        assert!(binding.validate().is_ok()); // Zero-byte attachments remain valid.
        let value = serde_json::to_value(&binding).unwrap();
        assert_eq!(value["clientMessageId"], "message");
        assert_eq!(
            serde_json::from_value::<TurnRetainedInputV1>(value.clone()).unwrap(),
            binding
        );
        for field in ["trustedContext", "accessToken", "sourcePath"] {
            let mut forged = value.clone();
            forged[field] = serde_json::json!("forbidden");
            assert!(serde_json::from_value::<TurnRetainedInputV1>(forged).is_err());
        }
        for id in [
            "r1.root.01.0123456789abcdef0123456789abcdef",
            "r1.root.0.0123456789abcdef0123456789abcdef",
            "r1.foreign.1.0123456789abcdef0123456789abcdef",
            "r1.root.2.0123456789abcdef0123456789abcdef",
            "r1.root.1.nonce",
            "r1.root.1.0123456789abcdef0123456789abcdeg",
            "r1.root.1.0123456789abcdef0123456789abcdef.extra",
        ] {
            let mut invalid = binding.clone();
            invalid.artifacts[0].retention_id = id.into();
            assert!(invalid.validate().is_err(), "{id}");
        }
        let mut invalid = binding.clone();
        invalid.version = 2;
        assert!(invalid.validate().is_err());
        invalid = binding.clone();
        invalid.artifacts[0].artifact_name = "../foreign".into();
        assert!(invalid.validate().is_err());
        invalid = binding.clone();
        invalid.artifacts[0].artifact_identity.kind = crate::PrivateFileKind::Directory;
        assert!(invalid.validate().is_err());
        invalid = binding.clone();
        invalid.artifacts[0].artifact_size = 100 * 1024 * 1024;
        assert!(invalid.validate().is_ok());
        invalid.artifacts[0].artifact_size += 1;
        assert!(invalid.validate().is_err());
        invalid = binding.clone();
        invalid.artifacts = vec![binding.artifacts[0].clone(); 33];
        assert!(invalid.validate().is_err());
    }
    #[test]
    fn retained_attempt_contract_rejects_duplicate_entries_leaves_and_revisions() {
        let mut binding = retained_binding();
        let mut other = binding.artifacts[0].clone();
        other.entry_id = "entry-b".into();
        other.artifact_name = "entry-b.bytes".into();
        binding.artifacts.push(other);
        assert!(binding.validate().is_ok());
        let valid = binding.clone();
        binding.artifacts.swap(0, 1);
        assert!(binding.validate().is_err());
        binding = valid.clone();
        binding.artifacts[1].expected_receipt_revision += 1;
        assert!(binding.validate().is_err());
        binding = valid.clone();
        binding.artifacts[1].artifact_name = binding.artifacts[0].artifact_name.clone();
        assert!(binding.validate().is_err());
        binding = valid.clone();
        binding.artifacts[1].retention_id = "r1.root.1.1123456789abcdef0123456789abcdef".into();
        binding.artifacts[1].entry_id = binding.artifacts[0].entry_id.clone();
        assert!(binding.validate().is_err());
    }
    #[test]
    fn legacy_known_and_future_raw_turn_statuses_roundtrip_without_guessing() {
        for raw in ["accepted", "completed", "failed", "interrupted"] {
            let status: TurnAttemptStatus = serde_json::from_value(serde_json::json!(raw)).unwrap();
            assert!(status.is_known());
            assert_eq!(status.is_terminal(), raw != "accepted");
            assert_eq!(serde_json::to_value(status).unwrap(), raw);
        }
        for raw in ["waiting_for_remote_cleanup", "Failed", "", "未来"] {
            let status: TurnAttemptStatus = serde_json::from_value(serde_json::json!(raw)).unwrap();
            assert!(!status.is_known());
            assert!(!status.is_terminal());
            assert_eq!(serde_json::to_value(status).unwrap(), raw);
        }
        assert!(
            serde_json::from_value::<TurnAttemptStatus>(serde_json::json!("界".repeat(86)))
                .is_err()
        );
        for value in [
            serde_json::json!(1),
            serde_json::json!({"unknown":"x"}),
            serde_json::Value::Null,
        ] {
            assert!(serde_json::from_value::<TurnAttemptStatus>(value).is_err());
        }
    }
}
