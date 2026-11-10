use super::*;
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
struct Scripted {
    replies: VecDeque<String>,
    sent: Arc<Mutex<Vec<Value>>>,
}
#[async_trait::async_trait]
impl McpTransport for Scripted {
    async fn send(&mut self, line: &str) -> Result<()> {
        self.sent.lock().unwrap().push(serde_json::from_str(line)?);
        Ok(())
    }
    async fn recv(&mut self) -> Result<Option<String>> {
        Ok(self.replies.pop_front())
    }
}
type ResourceFixture = (tempfile::TempDir, McpClient, Arc<Mutex<Vec<Value>>>);
fn fixture(contents: Value) -> Result<ResourceFixture> {
    let temp = tempfile::tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let sent = Arc::new(Mutex::new(Vec::new()));
    let transport = Scripted {
        replies: VecDeque::from([
            json!({"jsonrpc":"2.0","id":1,"result":{"contents":contents}}).to_string(),
        ]),
        sent: sent.clone(),
    };
    let mut client = McpClient::with_transport(Box::new(transport));
    client.initialized = true;
    client.server_capabilities = json!({"resources":{}});
    let config: crate::McpServerConfig = serde_json::from_value(
        json!({"name":"actual-origin-metadata-fixture","transport":"stdio","command":"not-executed"}),
    )?;
    let context = crate::server_policy::CredentialContext {
        config_dir: temp.path().into(),
        mode: kcoder_config::CredentialStoreMode::File,
    };
    client.native_origin =
        crate::native_origin::NativeMcpConnectionOrigin::capture(&config, Some(&context))?;
    Ok((temp, client, sent))
}
#[tokio::test]
async fn fixed_native_resource_uses_original_connection_and_content_revision_only() -> Result<()> {
    let (_temp, mut client, sent) = fixture(
        json!([{"uri":"mailbox://original/message-1","mimeType":"message/rfc822","text":"Subject: Owned fixture\n\nUntrusted content","_meta":{"approved":true,"revision":"not-authority"}}]),
    )?;
    let snapshot = client
        .read_native_resource(
            "mailbox://original/message-1",
            std::path::Path::new("."),
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(snapshot.uri, "mailbox://original/message-1");
    assert_eq!(snapshot.mime_type, "message/rfc822");
    assert_eq!(snapshot.revision.len(), 64);
    assert_ne!(snapshot.revision, "not-authority");
    assert_eq!(
        *sent.lock().unwrap(),
        vec![
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"mailbox://original/message-1"}})
        ]
    );
    Ok(())
}
#[tokio::test]
async fn absent_origin_closed_owner_or_cancel_never_reads_a_resource() -> Result<()> {
    for mode in 0..3 {
        let (_temp, mut client, sent) = fixture(json!([]))?;
        let cancel = CancellationToken::new();
        match mode {
            0 => client.native_origin = None,
            1 => client.native_origin().unwrap().revoke(),
            _ => cancel.cancel(),
        }
        assert!(
            client
                .read_native_resource(
                    "app://original/resource",
                    std::path::Path::new("."),
                    &cancel
                )
                .await
                .is_err()
        );
        assert!(sent.lock().unwrap().is_empty());
    }
    Ok(())
}
#[tokio::test]
async fn native_resource_rejects_changed_uri_blobs_ambiguous_and_oversize_content() -> Result<()> {
    for contents in [
        json!([]),
        json!([{"uri":"app://other/resource","text":"data"}]),
        json!([{"uri":"app://original/resource","blob":"ZGF0YQ==","text":"data"}]),
        json!([{"uri":"app://original/resource","text":"x".repeat(MAX_RESOURCE_BYTES+1)}]),
        json!([{"uri":"app://original/resource","text":"one"},{"uri":"app://original/resource","text":"two"}]),
    ] {
        let (_temp, mut client, _) = fixture(contents)?;
        assert!(
            client
                .read_native_resource(
                    "app://original/resource",
                    std::path::Path::new("."),
                    &CancellationToken::new()
                )
                .await
                .is_err()
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_discovery_rejects_private_uris_and_redacts_only_display_metadata() -> Result<()> {
    for uri in [
        "app://original/safe",
        "app://original/private-credential-canary",
    ] {
        let (_root, mut client, sent) = fixture(json!([]))?;
        client.policy_private_values =
            crate::tool::PrivateValues::new(["private-credential-canary".into()])?;
        client.transport = Box::new(Scripted { replies: VecDeque::from([json!({"jsonrpc":"2.0","id":1,"result":{"resources":[{"uri":uri,"name":"private-credential-canary title","_meta":{"canary":"private-credential-canary"}}]}}).to_string()]), sent });
        let result = client
            .list_native_resources(std::path::Path::new("."), &CancellationToken::new())
            .await;
        if uri.ends_with("safe") {
            let resources = result?;
            assert_eq!(resources[0].uri, uri);
            assert!(!resources[0].name.contains("private-credential-canary"));
            assert!(
                !resources[0]
                    .meta
                    .as_ref()
                    .unwrap()
                    .to_string()
                    .contains("private-credential-canary")
            );
        } else {
            assert!(result.is_err());
        }
    }
    Ok(())
}
#[tokio::test]
async fn native_resource_uses_the_actual_workspace_and_refuses_foreign_scope_before_dispatch()
-> Result<()> {
    let (_root, mut client, sent) = fixture(json!([]))?;
    let selected = tempfile::tempdir()?;
    let foreign = tempfile::tempdir()?;
    client.server_policy.workspace = Some(selected.path().to_string_lossy().into_owned());
    assert!(
        client
            .read_native_resource(
                "app://original/resource",
                foreign.path(),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(sent.lock().unwrap().is_empty());
    Ok(())
}
