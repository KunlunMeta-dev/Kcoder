//! First-party reads query the original task host, never a second task index.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskRead {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    pub query: ChannelPeerTaskQuery,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ChannelPeerTaskQuery {
    #[serde(deserialize_with = "list")]
    List(crate::ThreadListParams),
    #[serde(deserialize_with = "read")]
    Read(crate::ThreadReadParams),
    #[serde(deserialize_with = "read")]
    ReadIndexed(crate::ThreadReadParams),
    #[serde(deserialize_with = "creation")]
    Creation(crate::ThreadCreationReadParams),
    #[serde(deserialize_with = "receipt")]
    Receipt(crate::TurnReceiptReadParams),
    #[serde(deserialize_with = "goal")]
    Goal(crate::ThreadGoalParams),
    #[serde(deserialize_with = "goal")]
    GoalHistory(crate::ThreadGoalParams),
    Presence(crate::ThreadPresenceReadParams),
    Catalog(crate::ToolsCatalogParams),
}

impl ChannelPeerTaskRead {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        match &self.query {
            ChannelPeerTaskQuery::List(_) => {}
            ChannelPeerTaskQuery::Read(p) | ChannelPeerTaskQuery::ReadIndexed(p) => {
                atom(&p.thread_id)?
            }
            ChannelPeerTaskQuery::Creation(p) => {
                if p.client_request_id.trim().is_empty() || p.client_request_id.len() > 1024 {
                    return Err(invalid());
                }
            }
            ChannelPeerTaskQuery::Receipt(p) => {
                atom(&p.thread_id)?;
                p.validate().map_err(|_| invalid())?;
            }
            ChannelPeerTaskQuery::Goal(p) | ChannelPeerTaskQuery::GoalHistory(p) => {
                atom(&p.thread_id)?;
            }
            ChannelPeerTaskQuery::Presence(p) => atom(&p.thread_id)?,
            ChannelPeerTaskQuery::Catalog(p) => {
                if let Some(thread) = &p.thread_id {
                    atom(thread)?;
                }
            }
        }
        Ok(())
    }
}
impl ChannelPeerTaskQuery {
    pub fn original(&self) -> Result<(&'static str, serde_json::Value), serde_json::Error> {
        Ok(match self {
            Self::List(p) => (crate::method::THREAD_LIST, serde_json::to_value(p)?),
            Self::Read(p) => (crate::method::THREAD_READ, serde_json::to_value(p)?),
            Self::ReadIndexed(p) => (crate::method::THREAD_READ_INDEXED, serde_json::to_value(p)?),
            Self::Creation(p) => (
                crate::method::THREAD_CREATION_READ,
                serde_json::to_value(p)?,
            ),
            Self::Receipt(p) => (crate::method::TURN_RECEIPT_READ, serde_json::to_value(p)?),
            Self::Goal(p) => (crate::method::THREAD_GOAL_GET, serde_json::to_value(p)?),
            Self::GoalHistory(p) => (crate::method::THREAD_GOAL_HISTORY, serde_json::to_value(p)?),
            Self::Catalog(p) => (crate::method::TOOLS_CATALOG, serde_json::to_value(p)?),
            Self::Presence(p) => (
                crate::method::THREAD_PRESENCE_READ,
                serde_json::to_value(p)?,
            ),
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskReadOutput {
    pub query: ChannelPeerTaskQuery,
    pub response_id: ChannelPeerRequestId,
    pub response: serde_json::Value,
}
impl ChannelPeerTaskReadOutput {
    pub fn validate_for(
        &self,
        query: &ChannelPeerTaskQuery,
        id: &ChannelPeerRequestId,
    ) -> Result<(), String> {
        let frame = &self.response;
        request_id(id)?;
        if &self.response_id != id
            || self.query.original().map_err(|_| invalid())?
                != query.original().map_err(|_| invalid())?
            || frame.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0")
            || frame.get("id") != Some(&serde_json::to_value(id).map_err(|_| invalid())?)
            || frame.get("method").is_some()
            || (frame.get("result").is_some() == frame.get("error").is_some())
            || serde_json::to_vec(self).map_err(|_| invalid())?.len()
                > CHANNEL_PEER_FRAME_BYTES - 32 * 1024
        {
            return Err(invalid());
        }
        if let Some(result) = frame.get("result") {
            match query {
                ChannelPeerTaskQuery::List(_) => {
                    serde_json::from_value::<crate::ThreadListResult>(result.clone())
                        .map_err(|_| invalid())?;
                }
                ChannelPeerTaskQuery::Read(p) | ChannelPeerTaskQuery::ReadIndexed(p) => {
                    let read: crate::ThreadReadResult =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    if read.thread.id != p.thread_id {
                        return Err(invalid());
                    }
                }
                ChannelPeerTaskQuery::Creation(_) => {
                    serde_json::from_value::<crate::ThreadCreationReadResult>(result.clone())
                        .map_err(|_| invalid())?;
                }
                ChannelPeerTaskQuery::Receipt(p) => {
                    let read: crate::TurnReceiptReadResult =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    if read.receipt.is_some_and(|r| r.thread_id != p.thread_id) {
                        return Err(invalid());
                    }
                }
                ChannelPeerTaskQuery::Goal(p) => {
                    let read: crate::ThreadGoalGetResult =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    if read.thread_id != p.thread_id
                        || read.goal.is_some_and(|goal| goal.thread_id != p.thread_id)
                    {
                        return Err(invalid());
                    }
                }
                ChannelPeerTaskQuery::GoalHistory(p) => {
                    let read: crate::ThreadGoalHistoryResult =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    if read.thread_id != p.thread_id
                        || read.goals.iter().any(|goal| goal.thread_id != p.thread_id)
                    {
                        return Err(invalid());
                    }
                }
                ChannelPeerTaskQuery::Presence(p) => {
                    let read: crate::ThreadPresenceReadResultV1 =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    let thread = match &read {
                        crate::ThreadPresenceReadResultV1::Present { thread_id, .. }
                        | crate::ThreadPresenceReadResultV1::Absent { thread_id, .. }
                        | crate::ThreadPresenceReadResultV1::Unknown { thread_id, .. } => thread_id,
                    };
                    if thread != &p.thread_id {
                        return Err(invalid());
                    }
                }
                ChannelPeerTaskQuery::Catalog(p) => {
                    let read: crate::ToolsCatalogResult =
                        serde_json::from_value(result.clone()).map_err(|_| invalid())?;
                    if read.thread_id != p.thread_id
                        || read.cache_policy != crate::ToolCatalogCachePolicy::NoStore
                        || (p.thread_id.is_some() && read.scope != crate::ToolCatalogScope::Thread)
                        || (p.thread_id.is_none()
                            && read.scope != crate::ToolCatalogScope::Workspace)
                    {
                        return Err(invalid());
                    }
                }
            }
        } else {
            serde_json::from_value::<crate::RpcError>(frame["error"].clone())
                .map_err(|_| invalid())?;
        }
        Ok(())
    }
}

fn strict<'de, D, T>(deserializer: D, fields: &[&str]) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if !value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| fields.contains(&key.as_str())))
    {
        return Err(serde::de::Error::custom(
            "Invalid original task read parameters",
        ));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<crate::ThreadListParams, D::Error> {
    strict(d, &["allowPartial", "cursor", "limit", "archived", "query"])
}
fn read<'de, D: serde::Deserializer<'de>>(d: D) -> Result<crate::ThreadReadParams, D::Error> {
    strict(d, &["threadId", "limit", "beforeCursor"])
}
fn creation<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::ThreadCreationReadParams, D::Error> {
    strict(d, &["clientRequestId"])
}
fn receipt<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::TurnReceiptReadParams, D::Error> {
    strict(d, &["threadId", "clientMessageId", "retryOperationId"])
}
fn goal<'de, D: serde::Deserializer<'de>>(d: D) -> Result<crate::ThreadGoalParams, D::Error> {
    strict(d, &["threadId", "expectedGoalId", "expectedRevision"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn queries_keep_original_public_parameters_without_an_execution_surface() {
        for (kind, params, method) in [
            (
                "catalog",
                json!({"threadId":"original","asyncUserQuestions":true}),
                crate::method::TOOLS_CATALOG,
            ),
            (
                "list",
                json!({"limit":5,"archived":true,"query":"original"}),
                crate::method::THREAD_LIST,
            ),
            (
                "read",
                json!({"threadId":"original","limit":5,"beforeCursor":"page"}),
                crate::method::THREAD_READ,
            ),
            (
                "creation",
                json!({"clientRequestId":"original-create"}),
                crate::method::THREAD_CREATION_READ,
            ),
            (
                "read_indexed",
                json!({"threadId":"original","limit":5,"beforeCursor":"page"}),
                crate::method::THREAD_READ_INDEXED,
            ),
            (
                "receipt",
                json!({"threadId":"original","clientMessageId":"original-message"}),
                crate::method::TURN_RECEIPT_READ,
            ),
            (
                "goal",
                json!({"threadId":"original","expectedGoalId":"goal","expectedRevision":2}),
                crate::method::THREAD_GOAL_GET,
            ),
            (
                "goal_history",
                json!({"threadId":"original"}),
                crate::method::THREAD_GOAL_HISTORY,
            ),
            (
                "presence",
                json!({"threadId":"original"}),
                crate::method::THREAD_PRESENCE_READ,
            ),
        ] {
            let value = json!({"method":kind,"params":params});
            let query: ChannelPeerTaskQuery = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(query.original().unwrap().0, method);
            for field in [
                "actor",
                "input",
                "trusted",
                "permissionMode",
                "backgroundAuthorized",
            ] {
                let mut forged = value.clone();
                forged["params"][field] = json!("caller-claim");
                assert!(serde_json::from_value::<ChannelPeerTaskQuery>(forged).is_err());
            }
        }
        assert!(
            serde_json::from_value::<ChannelPeerTaskQuery>(
                json!({"method":"turn_start","params":{}})
            )
            .is_err()
        );
    }
    #[test]
    fn read_output_is_bound_to_the_original_query_and_rpc_response() {
        let query = ChannelPeerTaskQuery::Receipt(crate::TurnReceiptReadParams {
            thread_id: "original".into(),
            client_message_id: Some("message".into()),
            retry_operation_id: None,
        });
        let mut output = ChannelPeerTaskReadOutput {
            query: query.clone(),
            response_id: ChannelPeerRequestId::Number(1),
            response: json!({"jsonrpc":"2.0","id":1,"result":{"receipt":null}}),
        };
        output
            .validate_for(&query, &ChannelPeerRequestId::Number(1))
            .unwrap();
        assert!(
            output
                .validate_for(&query, &ChannelPeerRequestId::Number(2))
                .is_err()
        );
        let other = ChannelPeerTaskQuery::Receipt(crate::TurnReceiptReadParams {
            thread_id: "another".into(),
            client_message_id: Some("message".into()),
            retry_operation_id: None,
        });
        assert!(
            output
                .validate_for(&other, &ChannelPeerRequestId::Number(1))
                .is_err()
        );
        output.response["result"]["receipt"] =
            json!({"threadId":"another","turnId":"turn","status":"completed"});
        assert!(
            output
                .validate_for(&query, &ChannelPeerRequestId::Number(1))
                .is_err()
        );
    }

    #[test]
    fn goal_reads_reject_foreign_task_results_and_cannot_change_the_goal() {
        let value = json!({"method":"goal","params":{"threadId":"original"}});
        let query: ChannelPeerTaskQuery = serde_json::from_value(value.clone()).unwrap();
        let mut output = ChannelPeerTaskReadOutput {
            query: query.clone(),
            response_id: ChannelPeerRequestId::Number(1),
            response: json!({"jsonrpc":"2.0","id":1,"result":{"threadId":"original","goal":null}}),
        };
        output.validate_for(&query, &output.response_id).unwrap();
        output.response["result"]["threadId"] = json!("other");
        assert!(output.validate_for(&query, &output.response_id).is_err());
        for field in [
            "objective",
            "status",
            "mode",
            "tokenBudget",
            "clearTokenBudget",
        ] {
            let mut forged = value.clone();
            forged["params"][field] = json!("change");
            assert!(serde_json::from_value::<ChannelPeerTaskQuery>(forged).is_err());
        }
    }
}
