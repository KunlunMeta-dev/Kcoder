//! Public Agent reads remain bound to the selected account/workspace and explicit capabilities.
use super::*;
use kcoder_app_protocol::{
    CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1, CAPABILITY_MIGRATION_DEFINITIONS_V1,
    MigrationAgentPreviewParams, MigrationAgentPreviewResult, MigrationDefinitionBodyParams,
    MigrationDefinitionBodyResult, method,
};

#[tokio::test]
async fn target_agent_preview_and_body_use_public_caps_and_old_targets_receive_no_agent_call() {
    for supported in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base =
            reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                super::CheckedFixtureHandshake {
                    authorization: "Bearer owned-agent-fixture",
                    query_parts: &["server=owned-target", "workspace=%2Fowned-workspace"],
                },
            )
            .await
            .unwrap();
            let initialize: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            socket.send(Message::Text(json!({"jsonrpc":"2.0","id":initialize["id"],"result":{"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"capabilities":{"experimental":{"migrationBatchV1":true,"migrationAgentAdaptationV1":supported,"migrationDefinitionsV1":supported}}}}).to_string().into())).await.unwrap();
            if !supported {
                assert!(
                    matches!(socket.next().await.unwrap().unwrap(), Message::Close(_)),
                    "cap absence must reject before sending any Agent RPC"
                );
                return;
            }
            for expected in [
                method::MIGRATION_AGENT_PREVIEW,
                method::MIGRATION_DEFINITION_BODY,
            ] {
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(request["method"], expected);
                assert_eq!(request["params"]["jobId"], "owned-job");
                assert_eq!(request["params"]["itemId"], "owned-agent");
                assert!(request["params"].get("path").is_none());
                let result = if expected == method::MIGRATION_AGENT_PREVIEW {
                    json!({"jobId":"owned-job","itemId":"owned-agent","compatibility":{"sourceSha256":"a".repeat(64),"canAdapt":true,"availableTools":["read"],"sourceModelReference":true,"problem":null}})
                } else {
                    json!({"jobId":"owned-job","itemId":"owned-agent","offset":0,"encoding":"utf8","bytesBase64":"T3duZWQ=","text":"Owned","totalBytes":5,"sha256":"a".repeat(64),"nextOffset":null})
                };
                socket
                    .send(Message::Text(
                        json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        });
        let authorization = reqwest::header::HeaderValue::from_static("Bearer owned-agent-fixture");
        let mut client = Client::connect(
            &base,
            &authorization,
            "cookie-auth",
            "owned-target",
            Some("/owned-workspace"),
        )
        .await
        .unwrap();
        if supported {
            client
                .require(CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1)
                .unwrap();
            let preview: MigrationAgentPreviewResult = client
                .call(
                    method::MIGRATION_AGENT_PREVIEW,
                    &MigrationAgentPreviewParams {
                        job_id: "owned-job".into(),
                        item_id: "owned-agent".into(),
                    },
                )
                .await
                .unwrap();
            assert_eq!(preview.item_id, "owned-agent");
            client.require(CAPABILITY_MIGRATION_DEFINITIONS_V1).unwrap();
            let body: MigrationDefinitionBodyResult = client
                .call(
                    method::MIGRATION_DEFINITION_BODY,
                    &MigrationDefinitionBodyParams {
                        job_id: "owned-job".into(),
                        item_id: "owned-agent".into(),
                        offset: 0,
                    },
                )
                .await
                .unwrap();
            assert_eq!(body.text.as_deref(), Some("Owned"));
        } else {
            assert!(
                client
                    .require(CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1)
                    .is_err()
            );
        }
        client.close().await.unwrap();
        server.await.unwrap();
    }
}
