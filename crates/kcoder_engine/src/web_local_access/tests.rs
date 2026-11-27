use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_permissions::{AutoAllowPrompt, PermissionDialogResult};
use kcoder_tools::{ToolExecutionMetadata, ToolRegistry, WebFetchTool};
use kcoder_types::TurnAttemptIdentity;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct ExplicitPrompt {
    calls: Arc<AtomicUsize>,
    allowed: bool,
    edit: Option<Value>,
}
#[async_trait::async_trait]
impl PermissionPrompt for ExplicitPrompt {
    async fn ask(&self, _: &str, _: String, _: &Value) -> PermissionResponse {
        PermissionResponse::AllowOnce
    }
    async fn ask_explicit_context_with_edit(
        &self,
        ctx: &PermissionRequestContext,
    ) -> PermissionDialogResult {
        assert_eq!(ctx.tool_name, "WebFetch");
        assert!(
            ctx.detail_lines
                .iter()
                .any(|line| line.starts_with("Origin: http://127.0.0.1:"))
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        PermissionDialogResult {
            response: if self.allowed {
                PermissionResponse::AllowOnce
            } else {
                PermissionResponse::DenyOnce
            },
            modified_input: self.edit.clone(),
        }
    }
}
fn engine(root: &std::path::Path) -> QueryEngine {
    let mut settings = kcoder_config::Settings {
        permission_mode: kcoder_config::PermissionMode::Yolo,
        ..kcoder_config::Settings::default()
    };
    settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
    TestEngineBuilder::new(root)
        .settings(settings)
        .tool_registry(ToolRegistry::new().register(WebFetchTool))
        .build_with_profile_directory()
}
fn input(url: &str) -> Value {
    json!({"url":url,"prompt":"read source"})
}
fn attempt(engine: &QueryEngine) -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "web-local-permission-turn".into(),
        attempt_id: "web-local-permission-attempt".into(),
    }
}

#[tokio::test]
async fn yolo_and_automatic_allow_do_not_grant_private_origin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let output = engine
        .execute_tool("automatic-local", "WebFetch", input(&url), &AutoAllowPrompt)
        .await
        .unwrap()
        .0;
    assert!(output.is_error);
    let calls = Arc::new(AtomicUsize::new(0));
    let prompt = ExplicitPrompt {
        calls: calls.clone(),
        allowed: false,
        edit: None,
    };
    assert!(
        engine
            .execute_tool("denied-local", "WebFetch", input(&url), &prompt)
            .await
            .unwrap()
            .0
            .is_error
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn channel_private_origin_uses_denying_prompt_without_touching_the_host_or_network() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path()).with_unattended_input();
    let calls = Arc::new(AtomicUsize::new(0));
    let prompt = ExplicitPrompt {
        calls: calls.clone(),
        allowed: true,
        edit: None,
    };
    let (output, decision, ..) = engine
        .execute_tool("channel-private", "WebFetch", input(&url), &prompt)
        .await
        .unwrap();
    assert!(output.is_error);
    assert_eq!(decision, kcoder_permissions::PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn actual_explicit_dispatch_reads_and_retains_owner_cache_between_calls() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        let body =
            "<main><h1>Owned source</h1><p>Actual native private origin approval.</p></main>";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "second native call should use only its owner cache"
        );
    });
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let prompt = ExplicitPrompt {
        calls: calls.clone(),
        allowed: true,
        edit: None,
    };
    engine
        .state
        .history_attempt_scope(attempt(&engine))
        .unwrap()
        .run(async {
            for (call, cached) in [("actual-local-first", false), ("actual-local-cached", true)] {
                let output = engine
                    .execute_tool(call, "WebFetch", input(&url), &prompt)
                    .await
                    .unwrap()
                    .0;
                assert!(!output.is_error, "{output:?}");
                let sources = output
                    .execution_metadata
                    .iter()
                    .find_map(|m| match m {
                        ToolExecutionMetadata::WebSources(receipt) => Some(receipt),
                        _ => None,
                    })
                    .expect("actual dispatch must issue the source receipt");
                assert_eq!(sources.tool_call_id, call);
                assert_eq!(sources.sources[0].cache_hit, cached);
                assert_eq!(
                    sources.sources[0].read_status,
                    kcoder_types::web_sources::WebSourceReadStatus::Read
                );
            }
        })
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.await.unwrap();
}
#[tokio::test]
async fn approval_cannot_be_edited_into_another_origin_or_reused_on_a_peer_tool() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let peerurl = format!("http://{}/", peer.local_addr().unwrap());
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let prompt = ExplicitPrompt {
        calls: calls.clone(),
        allowed: true,
        edit: Some(input(&peerurl)),
    };
    assert!(
        engine
            .execute_tool("edited-local", "WebFetch", input(&url), &prompt)
            .await
            .unwrap()
            .0
            .is_error
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), peer.accept())
            .await
            .is_err()
    );
    let prompt = ExplicitPrompt {
        calls,
        allowed: true,
        edit: None,
    };
    let original: Arc<dyn Tool> = Arc::new(WebFetchTool);
    let other: Arc<dyn Tool> = Arc::new(WebFetchTool);
    let approval = engine
        .approve_private_web_origin(&original, &input(&url), &prompt)
        .await
        .unwrap()
        .unwrap();
    let context = ToolContext::new(engine.state.clone())
        .with_tool_call_id("bound")
        .with_native_tool_invocation(&original, &input(&url))
        .unwrap();
    assert!(approval.apply(context, &other, &input(&url)).is_err());
}
#[tokio::test]
async fn private_grant_does_not_follow_a_cross_origin_redirect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let peerurl = format!("http://{}/", peer.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).await.unwrap() > 0);
        socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {peerurl}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let engine = engine(temp.path());
    let prompt = ExplicitPrompt {
        calls: Arc::default(),
        allowed: true,
        edit: None,
    };
    assert!(
        engine
            .execute_tool("redirect-local", "WebFetch", input(&url), &prompt)
            .await
            .unwrap()
            .0
            .is_error
    );
    server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), peer.accept())
            .await
            .is_err()
    );
}
