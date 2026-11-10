//! A selected Gateway runtime carries ordinary public migration RPC, never Native parent proof.
use anyhow::{Result, ensure};
use futures::{SinkExt, StreamExt};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const FRAME_LIMIT: usize = 2 * 1024 * 1024;
pub(super) struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    id: u64,
    capabilities: Value,
}
impl Client {
    pub(super) async fn connect(
        base: &reqwest::Url,
        access: &reqwest::header::HeaderValue,
        rpc_token: &str,
        target: &str,
        workspace: Option<&str>,
    ) -> Result<Self> {
        ensure!(
            !rpc_token.is_empty()
                && rpc_token.len() <= 128
                && rpc_token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
            "migration_remote_rpc_login_required"
        );
        ensure!(
            !target.is_empty()
                && target.len() <= 64
                && target
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
            "migration_remote_invalid_target"
        );
        let mut url = base
            .join("rpc")
            .map_err(|_| anyhow::anyhow!("migration_remote_invalid_gateway"))?;
        url.set_scheme(if base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| anyhow::anyhow!("migration_remote_invalid_gateway"))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("token", rpc_token)
                .append_pair("server", target);
            if let Some(workspace) = workspace {
                query.append_pair("workspace", workspace);
            }
        }
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| anyhow::anyhow!("migration_remote_invalid_gateway"))?;
        request
            .headers_mut()
            .insert("authorization", access.clone());
        let config = WebSocketConfig::default()
            .max_frame_size(Some(FRAME_LIMIT))
            .max_message_size(Some(FRAME_LIMIT));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| anyhow::anyhow!("migration_remote_connection_unavailable"))?
        .map_err(|_| anyhow::anyhow!("migration_remote_connection_unavailable"))?;
        let mut client = Self {
            socket,
            id: 0,
            capabilities: Value::Null,
        };
        let initialized: Value = client
            .call(
                "initialize",
                &json!({"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,
            "clientInfo":{"name":"kcoder-terminal-migration","version":env!("CARGO_PKG_VERSION")}}),
            )
            .await?;
        ensure!(
            initialized["protocolVersion"] == kcoder_app_protocol::PROTOCOL_VERSION,
            "migration_remote_update_required"
        );
        client.capabilities = initialized["capabilities"]["experimental"].clone();
        client.require(kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_V1)?;
        Ok(client)
    }
    pub(super) fn require(&self, capability: &str) -> Result<()> {
        ensure!(
            self.capabilities[capability] == true,
            "migration_remote_update_required"
        );
        Ok(())
    }
    pub(super) async fn call<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R> {
        ensure!(
            matches!(
                method,
                "initialize"
                    | "migration/batch/read"
                    | "migration/read"
                    | "migration/items"
                    | "migration/batch/item/plan"
                    | "migration/batch/plan"
                    | "migration/batch/run"
                    | "migration/cancel"
                    | "migration/instructions/page"
                    | "migration/instructions/body"
                    | "migration/agent/preview"
                    | "migration/definitions/body"
                    | "migration/batch/resources/read"
                    | "migration/batch/resources/increase"
                    | "migration/project/mcp/catalog"
                    | "migration/projects/targets"
                    | "migration/projects/target-roots"
                    | "migration/projects/report"
                    | "runtime.projects.upsert_local"
                    | "migration/batch/credential-sources"
            ),
            "migration_remote_operation_unavailable"
        );
        self.id += 1;
        let id = self.id;
        let body = serde_json::to_string(
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .map_err(|_| anyhow::anyhow!("migration_remote_invalid_request"))?;
        ensure!(
            body.len() <= FRAME_LIMIT,
            "migration_remote_request_budget_exceeded"
        );
        tokio::time::timeout(Duration::from_secs(30), async {
            self.socket
                .send(Message::Text(body.into()))
                .await
                .map_err(|_| anyhow::anyhow!("migration_remote_outcome_unknown"))?;
            for _ in 0..1024 {
                let frame = self
                    .socket
                    .next()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("migration_remote_outcome_unknown"))?
                    .map_err(|_| anyhow::anyhow!("migration_remote_outcome_unknown"))?;
                let text = match frame {
                    Message::Text(text) => text,
                    Message::Close(_) => anyhow::bail!("migration_remote_outcome_unknown"),
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => anyhow::bail!("migration_remote_invalid_response"),
                };
                ensure!(
                    text.len() <= FRAME_LIMIT,
                    "migration_remote_response_budget_exceeded"
                );
                let value: Value = serde_json::from_str(&text)
                    .map_err(|_| anyhow::anyhow!("migration_remote_invalid_response"))?;
                ensure!(
                    value["jsonrpc"] == "2.0",
                    "migration_remote_invalid_response"
                );
                if value["id"] != id {
                    ensure!(
                        value.get("id").is_none(),
                        "migration_remote_invalid_response"
                    );
                    continue;
                }
                ensure!(
                    value.get("method").is_none()
                        && value.get("params").is_none()
                        && (value.get("result").is_some() != value.get("error").is_some()),
                    "migration_remote_invalid_response"
                );
                ensure!(
                    value.get("error").is_none(),
                    "migration_remote_rpc_rejected_read_original_job"
                );
                return serde_json::from_value(
                    value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("migration_remote_invalid_response"))?,
                )
                .map_err(|_| anyhow::anyhow!("migration_remote_invalid_response"));
            }
            anyhow::bail!("migration_remote_event_budget_exceeded")
        })
        .await
        .map_err(|_| anyhow::anyhow!("migration_remote_outcome_unknown"))?
    }
    pub(super) async fn close(mut self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(5), self.socket.close(None))
            .await
            .map_err(|_| anyhow::anyhow!("migration_remote_connection_close_unknown"))?
            .map_err(|_| anyhow::anyhow!("migration_remote_connection_close_unknown"))
    }
}

#[cfg(test)]
struct CheckedFixtureHandshake {
    authorization: &'static str,
    query_parts: &'static [&'static str],
}

#[cfg(test)]
impl tokio_tungstenite::tungstenite::handshake::server::Callback for CheckedFixtureHandshake {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> std::result::Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        assert_eq!(request.headers()["authorization"], self.authorization);
        let query = request.uri().query().unwrap();
        for part in self.query_parts {
            assert!(query.contains(part));
        }
        Ok(response)
    }
}

#[cfg(test)]
#[path = "runtime/agent_tests.rs"]
mod agent_tests;
#[cfg(test)]
#[path = "runtime/project_tests.rs"]
mod project_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ordinary_gateway_rpc_preserves_bearer_scope_and_refuses_unreviewed_methods_or_crossed_replies()
     {
        for invalid in 0..3 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap()))
                .unwrap();
            let authorization =
                reqwest::header::HeaderValue::from_static("Bearer owned-fixture-only");
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    CheckedFixtureHandshake {
                        authorization: "Bearer owned-fixture-only",
                        query_parts: &["server=owned-target"],
                    },
                )
                .await
                .unwrap();
                let initialize: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(initialize["method"], "initialize");
                socket.send(Message::Text(json!({"jsonrpc":"2.0","id":initialize["id"],"result":{"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"capabilities":{"experimental":{"migrationBatchV1":true}}}}).to_string().into())).await.unwrap();
                let read: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(
                    read["method"], "migration/batch/read",
                    "turn/start must never reach the fixture"
                );
                let reply = match invalid {
                    0 => {
                        json!({"jsonrpc":"2.0","id":999,"result":{"PRIVATE_RESPONSE":"NEVER_ECHO"}})
                    }
                    1 => {
                        json!({"jsonrpc":"1.0","id":read["id"],"result":{"PRIVATE_RESPONSE":"NEVER_ECHO"}})
                    }
                    _ => {
                        json!({"jsonrpc":"2.0","id":read["id"],"method":"turn/start","result":{"PRIVATE_RESPONSE":"NEVER_ECHO"}})
                    }
                };
                socket
                    .send(Message::Text(reply.to_string().into()))
                    .await
                    .unwrap();
            });
            let mut client =
                Client::connect(&base, &authorization, "cookie-auth", "owned-target", None)
                    .await
                    .unwrap();
            assert!(
                client
                    .require(kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_WORKERS_V1)
                    .is_err()
            );
            let unreviewed = client
                .call::<_, Value>("turn/start", &json!({}))
                .await
                .unwrap_err();
            assert!(unreviewed.to_string().contains("operation_unavailable"));
            let crossed = client
                .call::<_, Value>("migration/batch/read", &json!({"jobId":"owned"}))
                .await
                .unwrap_err();
            assert!(crossed.to_string().contains("invalid_response"));
            assert!(!crossed.to_string().contains("NEVER_ECHO"));
            server.await.unwrap();
        }
    }
}
