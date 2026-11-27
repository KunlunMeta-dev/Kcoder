use super::*;
use kcoder_computer_use::{
    admission::Admissions,
    broker::DesktopBroker,
    client::DesktopClient,
    connection::serve_authenticated,
    session::DesktopSession,
    worker::{DesktopWorker, WorkerError, WorkerHandle},
};
use kcoder_types::computer_use::DesktopOwner;
use std::time::Duration;

struct NoDesktop;
#[async_trait::async_trait]
impl DesktopWorker for NoDesktop {
    async fn call(
        &mut self,
        _: &str,
        _: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerError> {
        Ok(
            json!({"isError":false,"content":[{"type":"text","text":"owned fixture observation; no desktop was accessed"}]}),
        )
    }
    async fn shutdown(&mut self) -> Result<(), WorkerError> {
        Ok(())
    }
}

pub(crate) async fn session(
    owner: DesktopOwner,
) -> (Arc<DesktopSession>, tokio::task::JoinHandle<()>) {
    let mut admissions = Admissions::default();
    let (id, secret) = admissions.issue(1, 3, owner.clone()).unwrap();
    let identity = admissions
        .consume(&id, secret.expose_for_bootstrap(), 1, 3)
        .unwrap();
    let broker =
        DesktopBroker::new(WorkerHandle::spawn(NoDesktop, Duration::from_secs(1)), 3).unwrap();
    let (client, stream) = tokio::io::duplex(4096);
    let serving = tokio::spawn(async move {
        let _ = serve_authenticated(stream, identity, broker).await;
    });
    let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
        .await
        .unwrap();
    (Arc::new(session), serving)
}

fn desktop_engine(base: &QueryEngine, session: Arc<DesktopSession>) -> (QueryEngine, String) {
    use kcoder_tools::Tool;
    let definition = serde_json::from_value(
        json!({"name":"Screenshot", "description":"fixture", "inputSchema":{"type":"object"}}),
    )
    .unwrap();
    let tool = Arc::new(kcoder_mcp::desktop_tool::DesktopTool::new(definition, session).unwrap());
    let name = tool.name();
    let mut tools = kcoder_tools::ToolRegistry::new();
    tools.try_register(tool).unwrap();
    (base.clone().with_turn_tools(tools), name)
}

async fn check_desktop(
    guard: &NativeTaskCapabilityScopeGuard,
    engine: &QueryEngine,
    name: &str,
) -> bool {
    let emitter = engine.native_tool_emitter_witness(name).unwrap();
    let input = json!({});
    guard
        .authorize(&NativeToolAuthorizationRequest {
            execution: Some(emitter.execution()),
            emitter: Some(&emitter),
            session_id: emitter.execution().session_id(),
            tool_name: name,
            source: emitter.source().clone(),
            input: &input,
            read_only: false,
            without_sandbox: false,
            phase: NativeToolAuthorizationPhase::Dispatch,
        })
        .await
        .is_ok()
}

#[tokio::test]
async fn native_desktop_requires_real_object_current_owner_and_live_revocable_lease() -> Result<()>
{
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard.bind(f.bind(none()).await?).await?;
    f.facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?
        .run(async {
            let owner = DesktopOwner {
                client_instance: "desktop-fixture".into(),
                thread_id: f.facts.initial.thread_id.clone(),
                turn_id: f.facts.initial.turn_id.clone(),
            };
            let (session, serving) = session(owner.clone()).await;
            let (engine, name) = desktop_engine(&f.facts.engine, session.clone());
            assert!(!check_desktop(&guard, &engine, &name).await);
            let binding = engine.bind_desktop_turn(owner.clone()).unwrap();
            assert!(check_desktop(&guard, &engine, &name).await);
            // A real MCP object carrying precisely the same source label is not native desktop authority.
            let captured = engine.native_tool_emitter_witness(&name).unwrap();
            let source = captured.source().clone();
            let (forged, forged_name) = emitter_engine(&engine, &source);
            assert!(!check_desktop(&guard, &forged, &forged_name).await);
            binding.revoker().revoke();
            assert!(!captured.authorizes_desktop_owner(&owner));
            assert!(!check_desktop(&guard, &engine, &name).await);
            drop(binding);
            let mut other = owner.clone();
            other.client_instance = "other-client".into();
            let wrong = engine.bind_desktop_turn(other).unwrap();
            assert!(!check_desktop(&guard, &engine, &name).await);
            drop(wrong);
            let mut stale_turn = owner.clone();
            stale_turn.turn_id = "stale-turn".into();
            let wrong_turn = engine.bind_desktop_turn(stale_turn).unwrap();
            assert!(!check_desktop(&guard, &engine, &name).await);
            drop(wrong_turn);
            let binding = engine.bind_desktop_turn(owner).unwrap();
            session.note_host_failure("lease_revoked");
            assert!(!check_desktop(&guard, &engine, &name).await);
            drop(binding);
            session.stop().await.unwrap();
            drop(captured);
            drop(engine);
            drop(session);
            tokio::time::timeout(Duration::from_secs(2), serving)
                .await
                .unwrap()
                .unwrap();
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    f.shutdown().await;
    Ok(())
}
