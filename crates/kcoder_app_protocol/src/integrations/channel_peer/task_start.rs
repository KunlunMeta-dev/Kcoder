//! Original task creation on an authenticated first-party app-server stream.
//! Neither a registration nor a creation request grants platform access.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppServerUiRegistration {
    /// Selects the original bounded public JSONL transport after authentication.
    /// It grants no task, platform, tool or background execution authority.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rpc_transport: bool,
    pub nonce: String,
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    pub expires_at_ms: u64,
    pub initialize: ChannelPeerInitialize,
}

impl AppServerUiRegistration {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        self.initialize.validate()?;
        if self.nonce.len() != 32
            || !self.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.source_authority_epoch == 0
            || self.expires_at_ms == 0
        {
            return Err(invalid());
        }
        Ok(())
    }
}

// Temporary MCP launch parameters are private and must never gain Debug output.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskStart {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(deserialize_with = "deserialize_original_start")]
    pub start: crate::ThreadStartParams,
}

impl ChannelPeerTaskStart {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if self.source_authority_epoch == 0
            || self
                .start
                .client_request_id
                .as_ref()
                .is_none_or(|id| id.trim().is_empty() || id.len() > 1024)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPeerTaskCreationSubscription {
    Detached,
    Attached,
    Existing,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskCreationOutput {
    pub client_request_id: String,
    pub response_id: ChannelPeerRequestId,
    /// Presentation state only; every input still needs original task access.
    pub subscription: ChannelPeerTaskCreationSubscription,
    pub frames: Vec<serde_json::Value>,
}

impl ChannelPeerTaskCreationOutput {
    /// These are the original dispatcher's bounded output frames, not copied
    /// session history. Keep the response and startup-event ordering intact.
    pub fn response(&self) -> Result<&serde_json::Value, String> {
        if self.client_request_id.trim().is_empty()
            || self.client_request_id.len() > 1024
            || self.frames.is_empty()
            || self.frames.len() > 64
        {
            return Err(invalid());
        }
        request_id(&self.response_id)?;
        if serde_json::to_vec(&self.frames)
            .map_err(|_| invalid())?
            .len()
            > CHANNEL_PEER_FRAME_BYTES - 32 * 1024
        {
            return Err(invalid());
        }
        let id = serde_json::to_value(&self.response_id).map_err(|_| invalid())?;
        let mut response = None;
        for frame in &self.frames {
            if frame.get("jsonrpc").and_then(serde_json::Value::as_str) != Some("2.0") {
                return Err(invalid());
            }
            if frame.get("id").is_some() {
                if frame["id"] != id
                    || frame.get("method").is_some()
                    || response.is_some()
                    || (frame.get("result").is_some() == frame.get("error").is_some())
                {
                    return Err(invalid());
                }
                response = Some(frame);
            }
        }
        let response = response.ok_or_else(invalid)?;
        let mut thread = if let Some(result) = response.get("result") {
            let result: crate::ThreadStartResult =
                serde_json::from_value(result.clone()).map_err(|_| invalid())?;
            atom(&result.thread.id)?;
            Some(result.thread.id)
        } else {
            if self.subscription != ChannelPeerTaskCreationSubscription::Detached {
                return Err(invalid());
            }
            serde_json::from_value::<crate::RpcError>(response["error"].clone())
                .map_err(|_| invalid())?;
            None
        };
        if self.subscription == ChannelPeerTaskCreationSubscription::Existing
            && self.frames.len() != 1
        {
            return Err(invalid());
        }
        for frame in self.frames.iter().filter(|frame| frame.get("id").is_none()) {
            let actual = frame
                .get("params")
                .and_then(|p| p.get("threadId"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(invalid)?;
            if let Some(thread) = &thread {
                if thread != actual {
                    return Err(invalid());
                }
            } else {
                thread = Some(actual.into());
            }
            if !super::valid_task_notification(actual, frame) {
                return Err(invalid());
            }
        }
        Ok(response)
    }
}

fn deserialize_original_start<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::ThreadStartParams, D::Error> {
    // Match the existing public creation surface, while excluding private
    // source constructors and forward-version fields on this same-image lane.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Original {
        #[serde(default)]
        agent_definition: Option<kcoder_types::agent_definition::AgentDefinitionRef>,
        #[serde(
            default,
            deserialize_with = "crate::thread_mcp::deserialize_thread_mcp_servers"
        )]
        mcp_servers: Vec<crate::ThreadMcpServerV1>,
        #[serde(default)]
        studio_work_mode: Option<kcoder_types::StudioWorkMode>,
        #[serde(default)]
        workflow_definition_id: Option<String>,
        #[serde(default)]
        client_request_id: Option<String>,
        #[serde(default)]
        session_mode: Option<crate::ThreadSessionMode>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        settings_template: Option<String>,
        #[serde(default)]
        metadata: std::collections::BTreeMap<String, String>,
    }
    let original = Original::deserialize(deserializer)?;
    Ok(crate::ThreadStartParams {
        agent_definition: original.agent_definition,
        mcp_servers: original.mcp_servers,
        studio_work_mode: original.studio_work_mode,
        workflow_definition_id: original.workflow_definition_id,
        client_request_id: original.client_request_id,
        session_mode: original.session_mode,
        cwd: original.cwd,
        model: original.model,
        settings_template: original.settings_template,
        metadata: original.metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rpc_transport_is_explicit_and_cannot_supply_execution_authority() {
        let mut value = json!({"nonce":"0123456789abcdef0123456789abcdef",
            "scope":{"accountId":"account","targetId":"target","workspaceId":"workspace",
                "identityGeneration":"epoch","targetRevision":"revision"},
            "sourceAuthorityEpoch":1,"expiresAtMs":1,
            "initialize":{"protocolVersion":crate::PROTOCOL_VERSION,
                "clientInfo":{"name":"original-rpc-client","version":"1"},
                "capabilities":{"experimental":{}}}});
        let legacy: AppServerUiRegistration = serde_json::from_value(value.clone()).unwrap();
        legacy.validate().unwrap();
        assert!(!legacy.rpc_transport);
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("rpcTransport")
                .is_none()
        );
        value["rpcTransport"] = json!(true);
        let rpc: AppServerUiRegistration = serde_json::from_value(value.clone()).unwrap();
        rpc.validate().unwrap();
        assert!(rpc.rpc_transport);
        let frame = ChannelPeerClientFrame::AppServerUiRegister { registration: rpc };
        assert!(!ChannelPeerLane::Background.accepts(&frame));
        for field in [
            "principal",
            "backgroundAuthorized",
            "trusted",
            "permissionMode",
            "taskId",
        ] {
            let mut forged = value.clone();
            forged[field] = json!("caller-claim");
            assert!(serde_json::from_value::<AppServerUiRegistration>(forged).is_err());
        }
    }

    fn original() -> serde_json::Value {
        json!({"scope":{"accountId":"account","targetId":"target","workspaceId":"workspace",
            "identityGeneration":"epoch","targetRevision":"revision"},"sourceAuthorityEpoch":1,
            "start":{"clientRequestId":"original-create","model":"original-model",
                "metadata":{"project":"original"}}})
    }

    #[test]
    fn creation_keeps_original_parameters_and_cannot_contain_an_input_or_actor() {
        let value = original();
        let typed: ChannelPeerTaskStart = serde_json::from_value(value.clone()).unwrap();
        typed.validate().unwrap();
        let public: crate::ThreadStartParams =
            serde_json::from_value(value["start"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(typed.start).unwrap(),
            serde_json::to_value(public).unwrap()
        );
        for field in [
            "input",
            "threadId",
            "trusted",
            "actor",
            "backgroundAuthorized",
            "permissionMode",
        ] {
            let mut forged = value.clone();
            forged["start"][field] = json!("caller-claim");
            assert!(serde_json::from_value::<ChannelPeerTaskStart>(forged).is_err());
        }
        let mut missing = value;
        missing["start"]
            .as_object_mut()
            .unwrap()
            .remove("clientRequestId");
        assert!(
            serde_json::from_value::<ChannelPeerTaskStart>(missing)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn app_server_registration_needs_no_invented_task_or_platform_actor() {
        let value = json!({"nonce":"a".repeat(32),"scope":original()["scope"],
            "sourceAuthorityEpoch":1,"expiresAtMs":1,"initialize":{
                "protocolVersion":crate::PROTOCOL_VERSION,"clientInfo":{"name":"original-ui","version":"1"},
                "capabilities":{"experimental":{}}}});
        let parsed: AppServerUiRegistration = serde_json::from_value(value.clone()).unwrap();
        parsed.validate().unwrap();
        for field in [
            "resume",
            "threadId",
            "actor",
            "connectionId",
            "trusted",
            "backgroundAuthorized",
        ] {
            let mut forged = value.clone();
            forged[field] = json!("caller-claim");
            assert!(serde_json::from_value::<AppServerUiRegistration>(forged).is_err());
        }
    }

    #[test]
    fn creation_output_requires_the_original_response_and_one_task_event_stream() {
        let thread = json!({"id":"original-task","status":"idle", "createdAt":"now", "updatedAt":"now",
            "metadata":{"schema":"kcoder.thread-metadata","version":1,"revision":0}});
        let response = json!({"jsonrpc":"2.0","id":"create-call","result":{"thread":thread}});
        let event = json!({"jsonrpc":"2.0","method":"thread/started", "params":{
            "threadId":"original-task","thread":thread}});
        let mut output = ChannelPeerTaskCreationOutput {
            client_request_id: "stable-original-create".into(),
            response_id: ChannelPeerRequestId::Text("create-call".into()),
            subscription: ChannelPeerTaskCreationSubscription::Attached,
            frames: vec![response.clone(), event.clone()],
        };
        output.response().unwrap();
        output.subscription = ChannelPeerTaskCreationSubscription::Existing;
        assert!(
            output.response().is_err(),
            "An existing subscription cannot replay startup events"
        );
        output.frames.pop();
        output.response().unwrap();
        output.frames.push(event.clone());
        output.subscription = ChannelPeerTaskCreationSubscription::Attached;
        output.frames[0]["id"] = json!("another-call");
        assert!(output.response().is_err());
        output.frames[0] = response.clone();
        output.frames[1]["params"]["threadId"] = json!("another-task");
        assert!(output.response().is_err());
        output.frames[1] = event;
        output.frames.push(response);
        assert!(output.response().is_err());
        output.frames = vec![json!({"jsonrpc":"2.0","id":"create-call", "error":{
            "code":-32602,"message":"Original rejection"}})];
        assert!(
            output.response().is_err(),
            "A rejected creation cannot claim a live task"
        );
        output.subscription = ChannelPeerTaskCreationSubscription::Detached;
        output.response().unwrap();
        output.frames.push(json!({"jsonrpc":"2.0","method":"untrusted/notification","params":{"threadId":"original-task"}}));
        assert!(output.response().is_err());
    }
}
