use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A generic JSON-RPC 2.0 request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest<T> {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: String,
    pub params: T,
}

impl<T: Serialize> JsonRpcRequest<T> {
    pub fn new(id: u64, method: impl Into<String>, params: T) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: Some(id),
            method: method.into(),
            params,
        }
    }

    pub fn notification(method: impl Into<String>, params: T) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.into(),
            params,
        }
    }
}

/// A generic JSON-RPC 2.0 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse<T> {
    pub jsonrpc: String,
    pub id: Option<u64>,
    #[serde(default)]
    pub result: Option<T>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

/// Classify the envelope before matching IDs: each direction has its own request ID space.
pub(crate) enum InboundMessage {
    Request {
        id: Value,
        method: String,
    },
    Notification,
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<JsonRpcError>,
    },
}

pub(crate) fn decode_inbound(line: &str) -> anyhow::Result<InboundMessage> {
    let value: Value = serde_json::from_str(line)?;
    let object = value
        .as_object()
        .ok_or_else(|| crate::failure::protocol("invalid MCP JSON-RPC envelope"))?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(crate::failure::protocol("invalid MCP JSON-RPC version"));
    }
    if let Some(method) = object.get("method") {
        let method = method
            .as_str()
            .ok_or_else(|| crate::failure::protocol("invalid MCP request method"))?;
        if object.contains_key("result") || object.contains_key("error") {
            return Err(crate::failure::protocol("ambiguous MCP JSON-RPC envelope"));
        }
        return match object.get("id") {
            None => Ok(InboundMessage::Notification),
            Some(id) if valid_id(id) => Ok(InboundMessage::Request {
                id: id.clone(),
                method: method.into(),
            }),
            _ => Err(crate::failure::protocol("invalid MCP server request ID")),
        };
    }
    let id = object
        .get("id")
        .filter(|id| valid_id(id))
        .ok_or_else(|| crate::failure::protocol("invalid MCP response ID"))?
        .clone();
    let result = object.get("result").cloned();
    let error = object
        .get("error")
        .map(|error| serde_json::from_value(error.clone()))
        .transpose()?;
    if result.is_some() == error.is_some() {
        return Err(crate::failure::protocol(
            "MCP response must contain exactly one result or error",
        ));
    }
    Ok(InboundMessage::Response { id, result, error })
}

fn valid_id(id: &Value) -> bool {
    id.is_string() || id.as_u64().is_some() || id.as_i64().is_some()
}

/// MCP `initialize` request params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    #[serde(default = "empty_object")]
    pub capabilities: Value,
    pub client_info: Implementation,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

/// MCP `initialize` response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    #[serde(default)]
    pub capabilities: Value,
    pub server_info: Implementation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Implementation {
    pub name: String,
    pub version: String,
}

/// Result of `tools/list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListToolsResult {
    #[serde(default)]
    pub tools: Vec<McpToolDefinition>,
}

/// MCP tool definition returned by a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Value,
}

/// Params for `tools/call`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallToolParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// Result of `tools/call`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallToolResult {
    #[serde(default)]
    pub content: Vec<McpContent>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_serialization_keeps_present_id() {
        let value = serde_json::to_value(JsonRpcRequest::new(7, "tools/list", Value::Null))
            .expect("request 应可序列化");

        assert_eq!(
            value,
            json!({
                "jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": null
            })
        );
    }

    #[test]
    fn notification_serialization_omits_id() {
        let value = serde_json::to_value(JsonRpcRequest::notification(
            "notifications/initialized",
            Value::Null,
        ))
        .expect("notification 应可序列化");

        assert_eq!(
            value,
            json!({
                "jsonrpc": "2.0", "method": "notifications/initialized", "params": null
            })
        );
        assert!(
            !value
                .as_object()
                .expect("envelope 必须是 object")
                .contains_key("id")
        );
    }
}
