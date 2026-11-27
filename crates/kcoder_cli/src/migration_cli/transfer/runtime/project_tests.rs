//! The real runtime transport admits only the reviewed target-side Project operations.
use super::*;

#[tokio::test]
async fn project_target_methods_reach_the_fixed_runtime_but_source_and_arbitrary_writes_do_not() {
    let methods = [
        "migration/projects/targets",
        "migration/projects/target-roots",
        "migration/projects/report",
        "runtime.projects.upsert_local",
    ];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            super::CheckedFixtureHandshake {
                authorization: "Bearer project-transport-fixture",
                query_parts: &["server=original-target", "workspace=%2Factual-workspace"],
            },
        )
        .await
        .unwrap();
        let init: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        socket.send(Message::Text(json!({"jsonrpc":"2.0","id":init["id"],"result":{"protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"capabilities":{"experimental":{"migrationBatchV1":true,"migrationProjectsV1":true}}}}).to_string().into())).await.unwrap();
        for method in methods {
            let request: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(request["method"], method);
            assert_eq!(request["params"]["originalIntent"], true);
            socket
                .send(Message::Text(
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"observed":method}})
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
    let authorization =
        reqwest::header::HeaderValue::from_static("Bearer project-transport-fixture");
    let mut client = Client::connect(
        &base,
        &authorization,
        "cookie-auth",
        "original-target",
        Some("/actual-workspace"),
    )
    .await
    .unwrap();
    client
        .require(kcoder_app_protocol::CAPABILITY_MIGRATION_PROJECTS_V1)
        .unwrap();
    for unreviewed in [
        "migration/projects/discover",
        "migration/projects/source-roots",
        "runtime.projects.delete_local",
        "runtime.projects.upsert_local/extra",
        "turn/start",
    ] {
        assert!(
            client
                .call::<_, Value>(unreviewed, &json!({}))
                .await
                .unwrap_err()
                .to_string()
                .contains("migration_remote_operation_unavailable")
        );
    }
    for method in methods {
        let response: Value = client
            .call(method, &json!({"originalIntent":true}))
            .await
            .unwrap();
        assert_eq!(response["observed"], method);
    }
    client.close().await.unwrap();
    server.await.unwrap();
}
