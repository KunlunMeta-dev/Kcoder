//! Owned HTTP transport proves private reference routing and response redaction.
use kcoder_config::{
    CredentialStoreMode, OsCredentialBackend,
    imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues},
};
use kcoder_mcp::{McpServerConfig, server_policy::CredentialContext, tool::PrivateValues};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "SYNTHETIC_NATIVE_AUTH_TOKEN";

#[tokio::test]
async fn native_http_refs_use_the_explicit_profile_and_mask_tokens_on_the_real_wire() {
    tokio::time::timeout(Duration::from_secs(10), verify_private_http())
        .await
        .unwrap();
}

async fn verify_private_http() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&requests);
    // JoinSet aborts only this owned fixture if an assertion or timeout interrupts it.
    let mut peers = tokio::task::JoinSet::new();
    peers.spawn(async move {
        for _ in 0..9 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0 && bytes.len() + count <= 65536);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let head = std::str::from_utf8(&bytes[..end]).unwrap();
                    let length: usize = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                    }).unwrap();
                    if bytes.len() >= end + 4 + length {
                        let authorization = head.lines().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("authorization").then(|| value.trim())
                        });
                        assert!(authorization == Some(format!("Bearer {TOKEN}").as_str()));
                        break bytes[end + 4..end + 4 + length].to_vec();
                    }
                }
            };
            seen.fetch_add(1, Ordering::SeqCst);
            let request: Value = serde_json::from_slice(&body).unwrap();
            let payload = match request["method"].as_str().unwrap() {
                "initialize" => Some(json!({"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}})),
                "tools/list" => Some(json!({"tools":[{"name":"probe","description":TOKEN,"inputSchema":{"type":"object"}}]})),
                "tools/call" => Some(json!({"content":[{"type":"text","text":TOKEN}],"isError":false})),
                "notifications/initialized" => None,
                _ => panic!("unexpected fixture request"),
            };
            let (status, body) = match payload {
                Some(result) => ("200 OK", json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string()),
                None => ("202 Accepted", String::new()),
            };
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("settings.json"),
        r#"{"credential_store":"file","mcp_servers":[]}"#,
    )
    .unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = OsCredentialBackend::new();
    let mut config: McpServerConfig = serde_json::from_value(json!({"name":"owned-http","transport":"http","url":format!("http://{address}/mcp"),"policy":{"required_headers":["Authorization"],"startup_timeout_secs":3}})).unwrap();
    let reference = store
        .prepare_mcp(
            &config,
            &[],
            &["Authorization".into()],
            CredentialStoreMode::File,
            &backend,
        )
        .unwrap();
    let values = McpSecretValues {
        env: BTreeMap::new(),
        headers: BTreeMap::from([("Authorization".into(), format!("Bearer {TOKEN}"))]),
    };
    store
        .stage(&reference, &values.encode().unwrap(), &backend)
        .unwrap();
    config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
    store
        .publish_group(
            "group-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            std::slice::from_ref(&reference),
            &backend,
            |document| {
                document["mcp_servers"] = json!([config]);
                Ok(())
            },
        )
        .unwrap();
    let context = CredentialContext {
        config_dir: root.path().to_owned(),
        mode: CredentialStoreMode::File,
    };
    let other = tempfile::tempdir().unwrap();
    for invalid in [
        CredentialContext {
            mode: CredentialStoreMode::Keyring,
            ..context.clone()
        },
        CredentialContext {
            config_dir: other.path().to_owned(),
            ..context.clone()
        },
    ] {
        assert!(
            kcoder_mcp::connect_server_with_private_values_in(
                &config,
                None,
                Arc::new(PrivateValues::default()),
                Some(&invalid)
            )
            .await
            .is_err()
        );
    }
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    let (handle, definitions) = kcoder_mcp::connect_server_with_private_values_in(
        &config,
        None,
        Arc::new(PrivateValues::default()),
        Some(&context),
    )
    .await
    .unwrap();
    assert_eq!(definitions.len(), 1);
    assert!(!definitions[0].description.contains(TOKEN));
    let result = handle
        .lock()
        .await
        .call_tool("probe", json!({}))
        .await
        .unwrap();
    assert!(!format!("{result:?}").contains(TOKEN));
    let original =
        kcoder_mcp::McpTool::new(&config.name, Arc::clone(&handle), definitions[0].clone())
            .with_credential_context(context.clone());
    let (apps, tools) = original
        .connect_for_app(&config, None, Arc::new(|| true))
        .await
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert!(!tools[0].app_definition().description.contains(TOKEN));
    let app_result = apps
        .lock()
        .await
        .call_tool("probe", json!({}))
        .await
        .unwrap();
    assert!(!format!("{app_result:?}").contains(TOKEN));
    assert!(config.headers.is_empty());
    assert!(!serde_json::to_string(&config).unwrap().contains(TOKEN));
    drop(handle);
    drop(apps);
    drop(tools);
    drop(original);
    peers.join_next().await.unwrap().unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 9);
}
