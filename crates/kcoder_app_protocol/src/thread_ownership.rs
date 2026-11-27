//! Typed ownership refusals narrow history recovery; they do not grant access.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_THREAD_OWNERSHIP_ERRORS_V1: &str = "threadOwnershipErrorsV1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadOwnershipErrorReasonV1 {
    OwnedElsewhere,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadOwnershipErrorDataV1 {
    #[serde(deserialize_with = "version")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u32,
    pub reason: ThreadOwnershipErrorReasonV1,
    #[serde(deserialize_with = "thread_id")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
}

impl ThreadOwnershipErrorDataV1 {
    pub fn owned_elsewhere(thread_id: &str) -> Option<Self> {
        valid_thread(thread_id).then(|| Self {
            version: 1,
            reason: ThreadOwnershipErrorReasonV1::OwnedElsewhere,
            thread_id: thread_id.to_owned(),
        })
    }
}

fn valid_thread(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn version<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(decoder)?;
    if value != 1 {
        return Err(serde::de::Error::custom(
            "unsupported thread ownership error version",
        ));
    }
    Ok(value)
}
fn thread_id<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let value = String::deserialize(decoder)?;
    if !valid_thread(&value) {
        return Err(serde::de::Error::custom(
            "invalid thread ownership selector",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ownership_data_is_closed_versioned_and_bound_to_a_real_thread_selector() {
        let expected = json!({"version":1,"reason":"ownedElsewhere","threadId":"original_1"});
        assert_eq!(
            serde_json::to_value(ThreadOwnershipErrorDataV1::owned_elsewhere("original_1"))
                .unwrap(),
            expected
        );
        for value in [
            json!({"version":2,"reason":"ownedElsewhere","threadId":"original_1"}),
            json!({"version":1,"reason":"permissionDenied","threadId":"original_1"}),
            json!({"version":1,"reason":"ownedElsewhere","threadId":"../outside"}),
            json!({"version":1,"reason":"ownedElsewhere","threadId":"original_1","path":"private"}),
        ] {
            assert!(serde_json::from_value::<ThreadOwnershipErrorDataV1>(value).is_err());
        }
        assert!(ThreadOwnershipErrorDataV1::owned_elsewhere("").is_none());
    }
}
