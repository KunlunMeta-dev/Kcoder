//! Opt-in, point-in-time Goal observations; never execution authority.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_THREAD_GOAL_STATUS_BATCH_V1: &str = "threadGoalStatusBatchV1";
pub const MAX_THREAD_GOAL_STATUS_BATCH: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadGoalStatusBatchParams {
    #[serde(deserialize_with = "deserialize_thread_ids")]
    #[cfg_attr(feature = "json-schema", schemars(schema_with = "thread_ids_schema"))]
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadGoalStatusBatchResult {
    pub observations: Vec<ThreadGoalStatusBatchObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "availability", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadGoalStatusBatchObservation {
    Available {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(deserialize_with = "deserialize_nullable_status")]
        #[cfg_attr(
            feature = "json-schema",
            schemars(required, schema_with = "nullable_status_schema")
        )]
        status: Option<String>,
    },
    Unavailable {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
}

fn deserialize_nullable_status<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

fn deserialize_thread_ids<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let ids = Vec::<String>::deserialize(deserializer)?;
    if ids.is_empty() || ids.len() > MAX_THREAD_GOAL_STATUS_BATCH {
        return Err(D::Error::custom(
            "Goal observation batch size must be between 1 and 100",
        ));
    }
    let unique = ids.iter().collect::<std::collections::HashSet<_>>();
    if unique.len() != ids.len() {
        return Err(D::Error::custom(
            "Goal observation thread IDs must be unique",
        ));
    }
    Ok(ids)
}

#[cfg(feature = "json-schema")]
fn thread_ids_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    let mut schema = <Vec<String> as schemars::JsonSchema>::json_schema(generator);
    if let schemars::schema::Schema::Object(object) = &mut schema {
        let array = object.array.get_or_insert_with(Default::default);
        array.min_items = Some(1);
        array.max_items = Some(MAX_THREAD_GOAL_STATUS_BATCH as u32);
        array.unique_items = Some(true);
    }
    schema
}

#[cfg(feature = "json-schema")]
fn nullable_status_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn goal_batch_wire_shapes_require_explicit_nullable_status() {
        let params: ThreadGoalStatusBatchParams =
            serde_json::from_value(json!({"threadIds":["a","b"]})).unwrap();
        assert_eq!(params.thread_ids, ["a", "b"]);
        for raw in [
            json!({"threadIds":["a"],"path":"/private"}),
            json!({}),
            json!({"threadIds":3}),
            json!({"threadIds":[]}),
            json!({"threadIds":["a","a"]}),
            json!({"threadIds":(0..101).map(|index| format!("thread-{index}")).collect::<Vec<_>>()}),
        ] {
            assert!(serde_json::from_value::<ThreadGoalStatusBatchParams>(raw).is_err());
        }
        let result: ThreadGoalStatusBatchResult = serde_json::from_value(json!({"observations":[
            {"threadId":"a","availability":"available","status":null},
            {"threadId":"b","availability":"unavailable"},
            {"threadId":"c","availability":"available","status":"active"}
        ]}))
        .unwrap();
        assert_eq!(result.observations.len(), 3);
        assert!(
            serde_json::from_value::<ThreadGoalStatusBatchObservation>(
                json!({"threadId":"a","availability":"available"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ThreadGoalStatusBatchObservation>(
                json!({"threadId":"a","availability":"unavailable","status":null})
            )
            .is_err()
        );
    }
}
