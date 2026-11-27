//! Legacy locator names never replace actual endpoint observations.
use super::*;
use kcoder_config::{Settings, ToolProfile};
use kcoder_permissions::PermissionEngine;
use kcoder_state::AppState;
use kcoder_tools::ToolRegistry;
use std::{
    ffi::OsString,
    sync::atomic::{AtomicUsize, Ordering},
};

struct NoModel(Arc<AtomicUsize>);
impl kcoder_api::Provider for NoModel {
    fn name(&self) -> &'static str {
        "owned-windows-locator-no-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures::stream::empty()))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn windows_legacy_hints_remain_endpoint_verified_and_paged_in_both_consumers() -> Result<()> {
    use kcoder_tools::ToolContext;

    let (root, router) = fixture(true, true);
    let service = router.service.clone();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let storage = workspace.join("client-sessions");
    let history = workspace.join("history");
    kcoder_config::PrivateDirectory::open_or_create(&storage)?;
    kcoder_config::PrivateDirectory::open_or_create(&history)?;
    let paths = kcoder_config::ConfigPaths::with_config_dir_and_executable_dir(
        &workspace,
        profile.clone(),
        None,
    );
    let state = AppState::new(&workspace);
    state.with_history_path(history.join(format!("{}.jsonl", state.session_id())));
    let mut settings = Settings::default();
    settings.tools.profile = ToolProfile::Full;
    settings.context_window_tokens = Some(128_000);
    settings.context_output_headroom = Some(1024);
    let calls = Arc::new(AtomicUsize::new(0));
    let mut engine = QueryEngine::new_with_folder_trust(
        Arc::new(NoModel(calls.clone())),
        state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.clone(),
        Some(true),
    )
    .with_settings_persistence_path(paths.user_settings.clone());
    let owner = crate::peer_sessions::attach(&mut engine, paths.clone())?
        .context("actual owned LocalHost")?;
    let directory = service.live_registry(true)?.context("owned registry")?;
    let mut claims = Vec::new();
    for number in 0..11 {
        let name = OsString::from(format!(
            "owned-legacy-hint-{number:02}.{}.json",
            uuid::Uuid::new_v4()
        ));
        directory.atomic_publish_from_reader(
            &name,
            &mut &b"inaccessible forged locator body"[..],
            false,
            || Ok(()),
        )?;
        let claim = directory.open_single_link_regular_file(&name)?;
        fs2::FileExt::try_lock_exclusive(&claim)?;
        claims.push(claim);
    }

    fn check_page(result: &Value, expected_issues: u64, more: bool) -> Result<Option<String>> {
        assert_eq!(
            result["targets"],
            json!([]),
            "hints supply no resident facts or permissions"
        );
        assert_eq!(result["completeness"], "partial");
        assert_eq!(result["issueCount"], expected_issues);
        let cursor = result["nextCursor"].as_str().map(str::to_owned);
        assert_eq!(cursor.is_some(), more);
        Ok(cursor)
    }

    let list = engine
        .active_tool_registry()
        .get("ListSessions")
        .context("actual LocalHost discovery contribution")?
        .clone();
    let context = ToolContext::new(engine.state.clone());
    let mut cursor = None;
    for (issues, more) in [(10, true), (1, false)] {
        let input = cursor
            .as_ref()
            .map_or_else(|| json!({}), |cursor| json!({"cursor":cursor}));
        let output = list.call(input, &context).await?;
        assert!(!output.is_error);
        let [kcoder_types::ContentBlock::Text { text }] = output.content.as_slice() else {
            anyhow::bail!("actual discovery result is not text");
        };
        cursor = check_page(&serde_json::from_str(text)?, issues, more)?;
    }

    let identity = service.identity()?;
    let source_id = engine.session_id();
    let mut cursor = None;
    for (issues, more) in [(10, true), (1, false)] {
        let mut params = json!({"sourceThreadId":source_id});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let mut envelope = json!({
            "jsonrpc":"2.0", "id":1,
            "method":kcoder_app_protocol::cross_session_router::method::TARGETS,
            "params":params,
        });
        envelope[PRIVATE_AGENT_MESSAGE_ROUTE_FIELD] =
            serde_json::to_value(PrivatePeerRouteProofV1 {
                version: 1,
                purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
                authorization_id: "owned-windows-hint-route".into(),
                source: identity.clone(),
                destination: identity.clone(),
            })?;
        let request = PrivatePeerRouterRequest::decode(&serde_json::to_string(&envelope)?)
            .map_err(anyhow::Error::msg)?;
        let job = router.prepare(request, &ThreadManager::default())?;
        let result = tokio::task::spawn_blocking(move || job.execute()).await??;
        cursor = check_page(&result, issues, more)?;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    drop(claims);
    drop(owner);
    Ok(())
}
