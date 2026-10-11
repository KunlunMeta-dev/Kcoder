//! Domain-specific lifecycle labels. Wire and legacy storage remain strings.
//! Unknown same-schema labels remain readable without granting execution.
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MAX_DOMAIN_STATUS_UTF8_BYTES: usize = 256;

macro_rules! lifecycle_status {
    ($name:ident { $($variant:ident => $label:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum $name {
            $($variant,)+
            Unknown(String),
        }
        impl $name {
            pub fn from_raw(raw: &str) -> Result<Self, &'static str> {
                if raw.len() > MAX_DOMAIN_STATUS_UTF8_BYTES {
                    return Err("lifecycle status exceeds 256 UTF-8 bytes");
                }
                Ok(match raw {
                    $($label => Self::$variant,)+
                    _ => Self::Unknown(raw.into()),
                })
            }
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $label,)+
                    Self::Unknown(raw) => raw,
                }
            }
            pub fn is_known(&self) -> bool {
                !matches!(self, Self::Unknown(_))
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(deserializer)?;
                Self::from_raw(&raw).map_err(serde::de::Error::custom)
            }
        }
        #[cfg(feature = "json-schema")]
        impl schemars::JsonSchema for $name {
            fn schema_name() -> String {
                stringify!($name).into()
            }
            fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
                let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
                if let schemars::schema::Schema::Object(object) = &mut schema {
                    object.extensions.insert("x-max-utf8-bytes".into(), serde_json::json!(MAX_DOMAIN_STATUS_UTF8_BYTES));
                    object.extensions.insert("x-known-values".into(), serde_json::json!([$(Self::$variant,)+]));
                }
                schema
            }
        }
    };
}

lifecycle_status!(WikiJobStatus {
    Queued => "queued", Running => "running", Paused => "paused",
    AwaitingReview => "awaiting_review", Failed => "failed",
    Completed => "completed", Cancelled => "cancelled",
});
lifecycle_status!(WikiJobPhase {
    Analysis => "analysis", Generation => "generation",
    CitationRepair => "citation_repair", FormatRepair => "format_repair",
    SourceSupport => "source_support", OrganizationRepair => "organization_repair",
    TruncationRetry => "truncation_retry", Commit => "commit",
});
lifecycle_status!(WorkflowRunStatus {
    Running => "running", Completed => "completed", Failed => "failed",
    Cancelled => "cancelled", Interrupted => "interrupted",
});
lifecycle_status!(WorkflowNodeStatus {
    Pending => "pending", Running => "running", Retrying => "retrying",
    Completed => "completed", Failed => "failed", Skipped => "skipped",
    Cancelled => "cancelled", Interrupted => "interrupted",
});

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_and_legacy_labels_are_exact_and_unknown_labels_are_lossless() {
        for raw in [
            "queued",
            "running",
            "awaiting_review",
            "cancelled",
            "completed",
        ] {
            let status: WikiJobStatus = serde_json::from_value(serde_json::json!(raw)).unwrap();
            assert!(status.is_known());
            assert_eq!(serde_json::to_value(status).unwrap(), raw);
        }
        for raw in ["waiting_for_external_review", "Completed", "", "未来状态"] {
            let status: WorkflowRunStatus = serde_json::from_value(serde_json::json!(raw)).unwrap();
            assert_eq!(status, WorkflowRunStatus::Unknown(raw.into()));
            assert_eq!(serde_json::to_value(status).unwrap(), raw);
        }
        assert!(!WikiJobStatus::from_raw("pending").unwrap().is_known());
        assert!(!WorkflowRunStatus::from_raw("queued").unwrap().is_known());
        assert!(
            !WorkflowNodeStatus::from_raw("awaiting_review")
                .unwrap()
                .is_known()
        );
        assert!(!WikiJobPhase::from_raw("completed").unwrap().is_known());
    }
    #[test]
    fn future_labels_are_bounded_in_utf8_bytes() {
        let raw = "界".repeat(85);
        assert!(WorkflowNodeStatus::from_raw(&raw).is_ok());
        assert!(WikiJobPhase::from_raw(&format!("{raw}界")).is_err());
        assert!(
            serde_json::from_value::<WorkflowRunStatus>(serde_json::json!("x".repeat(257)))
                .is_err()
        );
    }
}
