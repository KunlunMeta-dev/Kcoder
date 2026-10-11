use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MAX_STATUS_UTF8_BYTES: usize = 256;

/// Task lifecycle facts. A newer same-schema status remains readable and is
/// preserved verbatim, but does not grant execution or imply completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Running,
    Paused,
    Halted,
    Completed,
    Failed,
    Cancelled,
    Unknown(String),
}

impl TaskStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Halted => "halted",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown(raw) => raw,
        }
    }

    pub fn is_known(&self) -> bool {
        !matches!(self, Self::Unknown(_))
    }
}

impl Serialize for TaskStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TaskStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw.len() > MAX_STATUS_UTF8_BYTES {
            return Err(serde::de::Error::custom(
                "task status exceeds 256 UTF-8 bytes",
            ));
        }
        Ok(match raw.as_str() {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "halted" => Self::Halted,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(raw),
        })
    }
}

// The custom serde contract accepts future raw labels. A closed enum schema or
// codepoint-based maxLength would reject readable same-schema task history.
#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for TaskStatus {
    fn schema_name() -> String {
        "TaskStatus".into()
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
                    Self::Pending,
                    Self::Running,
                    Self::Paused,
                    Self::Halted,
                    Self::Completed,
                    Self::Failed,
                    Self::Cancelled,
                ]),
            );
        }
        schema
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_boundary_preserves_raw_status_without_restricting_future_labels() {
        for raw in ["汉".repeat(85) + "a", "😀".repeat(64), String::new()] {
            let status: TaskStatus = serde_json::from_value(serde_json::json!(&raw)).unwrap();
            assert_eq!(status.as_str(), raw);
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(raw)
            );
        }
        for raw in ["汉".repeat(85) + "ab", "😀".repeat(65)] {
            assert!(serde_json::from_value::<TaskStatus>(serde_json::json!(raw)).is_err());
        }
    }

    #[test]
    fn future_status_roundtrips_without_implying_a_known_state() {
        let status: TaskStatus = serde_json::from_str("\"future_review\"").unwrap();
        assert!(!status.is_known());
        assert_eq!(serde_json::to_string(&status).unwrap(), "\"future_review\"");
        assert_eq!(
            serde_json::from_str::<TaskStatus>("\"completed\"").unwrap(),
            TaskStatus::Completed
        );
        assert!(serde_json::from_str::<TaskStatus>("0").is_err());
        assert!(serde_json::from_value::<TaskStatus>(serde_json::json!("x".repeat(257))).is_err());
    }
}
