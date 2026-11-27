//! Finite task controls retain the original dispatcher and its response contract.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskCommand {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    pub operation: ChannelPeerTaskCommandOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum ChannelPeerTaskCommandOperation {
    #[serde(rename = "thread/metadata/update", deserialize_with = "metadata")]
    Metadata(crate::ThreadMetadataUpdateParams),
    #[serde(rename = "thread/model/select")]
    Model(crate::ThreadModelSelectionParams),
    #[serde(rename = "thread/goal/set", deserialize_with = "goal_set")]
    GoalSet(crate::ThreadGoalSetParams),
    #[serde(rename = "thread/goal/clear", deserialize_with = "goal_clear")]
    GoalClear(crate::ThreadGoalParams),
    #[serde(rename = "thread/compact", deserialize_with = "compact")]
    Compact(crate::ThreadCompactParams),
    #[serde(rename = "thread/rollback", deserialize_with = "rollback")]
    Rollback(crate::ThreadRollbackParams),
}

impl ChannelPeerTaskCommand {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        atom(self.operation.thread_id())?;
        if let ChannelPeerTaskCommandOperation::Model(params) = &self.operation {
            params.validate().map_err(|_| invalid())?;
        }
        Ok(())
    }
}

impl ChannelPeerTaskCommandOperation {
    pub fn thread_id(&self) -> &str {
        match self {
            Self::Metadata(p) => &p.thread_id,
            Self::Model(p) => &p.thread_id,
            Self::GoalSet(p) => &p.thread_id,
            Self::GoalClear(p) => &p.thread_id,
            Self::Compact(p) => &p.thread_id,
            Self::Rollback(p) => &p.thread_id,
        }
    }
    pub fn original(&self) -> Result<(&'static str, serde_json::Value), serde_json::Error> {
        Ok(match self {
            Self::Metadata(p) => (
                crate::method::THREAD_METADATA_UPDATE,
                serde_json::to_value(p)?,
            ),
            Self::Model(p) => (crate::method::THREAD_MODEL_SELECT, serde_json::to_value(p)?),
            Self::GoalSet(p) => (crate::method::THREAD_GOAL_SET, serde_json::to_value(p)?),
            Self::GoalClear(p) => (crate::method::THREAD_GOAL_CLEAR, serde_json::to_value(p)?),
            Self::Compact(p) => (crate::method::THREAD_COMPACT, serde_json::to_value(p)?),
            Self::Rollback(p) => (crate::method::THREAD_ROLLBACK, serde_json::to_value(p)?),
        })
    }
    pub fn from_public(
        method: &str,
        params: serde_json::Value,
    ) -> Result<Option<Self>, serde_json::Error> {
        if !matches!(
            method,
            crate::method::THREAD_METADATA_UPDATE
                | crate::method::THREAD_MODEL_SELECT
                | crate::method::THREAD_GOAL_SET
                | crate::method::THREAD_GOAL_CLEAR
                | crate::method::THREAD_COMPACT
                | crate::method::THREAD_ROLLBACK
        ) {
            return Ok(None);
        }
        serde_json::from_value(serde_json::json!({"method":method,"params":params})).map(Some)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskCommandOutput {
    pub operation: ChannelPeerTaskCommandOperation,
    pub result: serde_json::Value,
}
impl ChannelPeerTaskCommandOutput {
    pub fn validate_for(&self, operation: &ChannelPeerTaskCommandOperation) -> Result<(), String> {
        if &self.operation != operation
            || serde_json::to_vec(self).map_err(|_| invalid())?.len()
                > CHANNEL_PEER_FRAME_BYTES - 32 * 1024
        {
            return Err(invalid());
        }
        let value = self.result.clone();
        let thread = operation.thread_id();
        let valid = match operation {
            ChannelPeerTaskCommandOperation::Metadata(_) => {
                serde_json::from_value::<crate::ThreadMetadataUpdateResult>(value)
                    .map(|r| r.thread.id == thread)
            }
            ChannelPeerTaskCommandOperation::Model(p) => {
                serde_json::from_value::<crate::ThreadModelSelectionResult>(value)
                    .map(|r| r.model == p.model)
            }
            ChannelPeerTaskCommandOperation::GoalSet(_) => {
                serde_json::from_value::<crate::ThreadGoalSetResult>(value)
                    .map(|r| r.thread_id == thread && r.goal.thread_id == thread)
            }
            ChannelPeerTaskCommandOperation::GoalClear(_) => {
                serde_json::from_value::<crate::ThreadGoalClearResult>(value)
                    .map(|r| r.thread_id == thread)
            }
            ChannelPeerTaskCommandOperation::Compact(_) => {
                serde_json::from_value::<crate::ThreadCompactResult>(value)
                    .map(|r| r.thread_id == thread)
            }
            ChannelPeerTaskCommandOperation::Rollback(_) => {
                serde_json::from_value::<crate::ThreadRollbackResult>(value)
                    .map(|r| r.thread_id == thread)
            }
        }
        .map_err(|_| invalid())?;
        if valid { Ok(()) } else { Err(invalid()) }
    }
}

fn strict<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(
    d: D,
    fields: &[&str],
) -> Result<T, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    if !value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| fields.contains(&key.as_str())))
    {
        return Err(serde::de::Error::custom(
            "Invalid original task command parameters",
        ));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn metadata<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::ThreadMetadataUpdateParams, D::Error> {
    strict(d, &["threadId", "title", "model", "archivedAt", "parent"])
}
fn goal_set<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::ThreadGoalSetParams, D::Error> {
    strict(
        d,
        &[
            "threadId",
            "objective",
            "edit",
            "expectedGoalId",
            "expectedRevision",
            "requireNoGoal",
            "mode",
            "verificationKind",
            "status",
            "tokenBudget",
            "clearTokenBudget",
        ],
    )
}
fn goal_clear<'de, D: serde::Deserializer<'de>>(d: D) -> Result<crate::ThreadGoalParams, D::Error> {
    strict(d, &["threadId", "expectedGoalId", "expectedRevision"])
}
fn compact<'de, D: serde::Deserializer<'de>>(d: D) -> Result<crate::ThreadCompactParams, D::Error> {
    strict(d, &["threadId"])
}
fn rollback<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::ThreadRollbackParams, D::Error> {
    strict(d, &["threadId", "turn"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn command_surface_cannot_borrow_runtime_or_background_authority() {
        for (method, params) in [
            (
                crate::method::THREAD_METADATA_UPDATE,
                json!({"threadId":"task","title":"renamed"}),
            ),
            (
                crate::method::THREAD_MODEL_SELECT,
                json!({"threadId":"task","model":"provider::model"}),
            ),
            (
                crate::method::THREAD_GOAL_SET,
                json!({"threadId":"task","objective":"explicit goal","requireNoGoal":true}),
            ),
            (
                crate::method::THREAD_GOAL_CLEAR,
                json!({"threadId":"task","expectedRevision":2}),
            ),
            (crate::method::THREAD_COMPACT, json!({"threadId":"task"})),
            (
                crate::method::THREAD_ROLLBACK,
                json!({"threadId":"task","turn":1}),
            ),
        ] {
            let original = ChannelPeerTaskCommandOperation::from_public(method, params.clone())
                .unwrap()
                .unwrap();
            assert_eq!(original.original().unwrap().0, method);
            assert_eq!(original.thread_id(), "task");
            for field in [
                "actor",
                "trusted",
                "permissionMode",
                "backgroundAuthorized",
                "input",
            ] {
                let mut forged = params.clone();
                forged[field] = json!(true);
                assert!(ChannelPeerTaskCommandOperation::from_public(method, forged).is_err());
            }
        }
        assert!(
            ChannelPeerTaskCommandOperation::from_public("turn/start", json!({}))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn output_cannot_apply_to_another_task_or_command() {
        let operation = ChannelPeerTaskCommandOperation::from_public(
            crate::method::THREAD_GOAL_CLEAR,
            json!({"threadId":"task","expectedRevision":2}),
        )
        .unwrap()
        .unwrap();
        let mut output = ChannelPeerTaskCommandOutput {
            operation: operation.clone(),
            result: json!({"threadId":"task","cleared":true}),
        };
        output.validate_for(&operation).unwrap();
        output.result["threadId"] = json!("other");
        assert!(output.validate_for(&operation).is_err());
        output.result = json!({"threadId":"task","cleared":true});
        let other = ChannelPeerTaskCommandOperation::from_public(
            crate::method::THREAD_GOAL_CLEAR,
            json!({"threadId":"task","expectedRevision":3}),
        )
        .unwrap()
        .unwrap();
        assert!(output.validate_for(&other).is_err());
    }
}
