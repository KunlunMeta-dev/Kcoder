// ReadSession through the real tool, channel, resident manager and saved directory.
// Included into the discovery test module so the owned fixture stays private.

impl Fixture {
    fn reader(
        &self,
        workspace: &Path,
        access: kcoder_config::SessionReadAccess,
    ) -> anyhow::Result<QueryEngine> {
        let mut settings = Self::settings();
        settings.cross_session_messages.read_access = access;
        self.engine(
            workspace,
            self.services.clone(),
            settings,
            self.provider.clone(),
        )
    }

    async fn read(&mut self, source: &QueryEngine, input: Value) -> Result<String, String> {
        let tool = source
            .active_tool_registry()
            .get("ReadSession")
            .expect("real ReadSession contribution");
        let context = ToolContext::new(source.state.clone());
        let task = tokio::spawn(async move { tool.call(input, &context).await });
        let request = tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .expect("read request reached the owned host")
            .expect("owned discovery channel open");
        dispatch(request, &self.manager, &mut self.pages).await;
        match task.await.expect("tool task") {
            Ok(output) => Ok(output
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn saved_conversation(engine: &QueryEngine) -> anyhow::Result<()> {
    engine
        .state
        .add_message(Message::user_text("第一个问题：安装包放在哪里？"));
    engine.state.add_message(Message::Assistant {
        content: vec![
            ContentBlock::Thinking {
                thinking: "PRIVATE-REASONING-SHOULD-NOT-LEAK".into(),
                signature: String::new(),
            },
            ContentBlock::Text {
                text: "我先查看目录。".into(),
            },
            ContentBlock::ToolUse {
                id: "owned-call-1".into(),
                name: "bash".into(),
                input: json!({"command":"ls dist"}),
            },
        ],
        usage: None,
    });
    engine.state.add_message(Message::User {
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "owned-call-1".into(),
            content: vec![ContentBlock::Text {
                text: "TOOL-OUTPUT-kcoder-setup.exe".into(),
            }],
            is_error: Some(false),
        }],
        origin: kcoder_types::MessageOrigin::Unknown,
        agent_message: None,
    });
    engine
        .state
        .add_message(Message::assistant_text("第一个答案：在 dist 目录。"));
    engine.state.add_message(Message::User {
        content: vec![
            ContentBlock::Text {
                text: "第二个问题，配置是 OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx".into(),
            },
            ContentBlock::Image {
                source: kcoder_types::ImageSource::base64("image/png", "aGVsbG8gd29ybGQ="),
            },
        ],
        origin: kcoder_types::MessageOrigin::User,
        agent_message: None,
    });
    engine
        .state
        .add_message(Message::assistant_text("第二个答案：密钥不要写进仓库。"));
    engine.state.save_history()?;
    Ok(())
}

#[tokio::test]
async fn saved_conversation_reads_visible_text_without_activation() -> anyhow::Result<()> {
    if !owned_case("saved_conversation_reads_visible_text_without_activation")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = cold_peer(&fixture)?;
    saved_conversation(&peer)?;
    let peer_id = peer.session_id();
    let history = peer.state.history_path().unwrap();
    drop(peer);
    let storage_before = files(&source.client_storage_root())?;
    let history_before = std::fs::read(&history)?;
    let text = fixture
        .read(&source, json!({"threadId": peer_id, "turns": 10}))
        .await
        .map_err(anyhow::Error::msg)?;
    for wanted in [
        "第一个问题：安装包放在哪里？",
        "我先查看目录。",
        "第一个答案：在 dist 目录。",
        "第二个答案：密钥不要写进仓库。",
        "[图片已省略]",
        "[已省略敏感内容]",
        "<<<ReadSession 记录开始",
        "来源：已保存的会话记录",
        "nextBeforeTurnId: 无",
    ] {
        assert!(text.contains(wanted), "missing {wanted} in {text}");
    }
    for hidden in [
        "PRIVATE-REASONING",
        "TOOL-OUTPUT",
        "ls dist",
        "abcdefghijklmnopqrstuvwx",
        "aGVsbG8",
    ] {
        assert!(!text.contains(hidden), "leaked {hidden}");
    }
    assert!(text.find("第一个问题").unwrap() < text.find("第二个答案").unwrap());
    let outputs = fixture
        .read(
            &source,
            json!({"threadId": peer_id, "turns": 10, "includeOutputs": true, "includeAttachments": true}),
        )
        .await
        .map_err(anyhow::Error::msg)?;
    assert!(outputs.contains("工具调用 bash（参数）："));
    assert!(outputs.contains("ls dist"));
    assert!(outputs.contains("工具结果 bash："));
    assert!(outputs.contains("TOOL-OUTPUT-kcoder-setup.exe"));
    assert!(outputs.contains("类型：image/png"));
    assert!(!outputs.contains("PRIVATE-REASONING") && !outputs.contains("aGVsbG8"));
    // Paging: the newest turn first, then everything before it.
    let newest = fixture
        .read(&source, json!({"threadId": peer_id, "turns": 1}))
        .await
        .map_err(anyhow::Error::msg)?;
    assert!(newest.contains("第二个答案") && !newest.contains("第一个答案"));
    let before = newest
        .lines()
        .find_map(|line| line.strip_prefix("nextBeforeTurnId: "))
        .and_then(|rest| rest.split_whitespace().next())
        .expect("paging cursor")
        .to_owned();
    let older = fixture
        .read(
            &source,
            json!({"threadId": peer_id, "beforeTurnId": before, "turns": 10}),
        )
        .await
        .map_err(anyhow::Error::msg)?;
    assert!(older.contains("第一个答案") && !older.contains("第二个答案"));
    let missing_turn = fixture
        .read(
            &source,
            json!({"threadId": peer_id, "turnId": "no-such-turn"}),
        )
        .await
        .unwrap_err();
    assert!(
        missing_turn.contains("session_read_turn_not_found"),
        "{missing_turn}"
    );
    assert_eq!(
        fixture.manager.resident_engines().len(),
        1,
        "no target was loaded"
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read(&history)?,
        history_before,
        "history unchanged"
    );
    assert_eq!(files(&source.client_storage_root())?, storage_before);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn archived_hidden_and_foreign_account_targets_follow_visibility() -> anyhow::Result<()> {
    if !owned_case("archived_hidden_and_foreign_account_targets_follow_visibility")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let archived = cold_peer(&fixture)?;
    thread_metadata::update_thread_metadata(
        &archived,
        ThreadMetadataUpdateParams {
            thread_id: archived.session_id(),
            title: MetadataUpdate::Set("Archived peer".into()),
            archived_at: MetadataUpdate::Set("2026-11-12T12:00:00Z".into()),
            ..Default::default()
        },
        &HashSet::new(),
        true,
    )?;
    let archived_id = archived.session_id();
    drop(archived);
    let text = fixture
        .read(&source, json!({"threadId": archived_id}))
        .await
        .map_err(anyhow::Error::msg)?;
    assert!(text.contains("Archived peer") && text.contains("已归档"));
    let ephemeral = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(ephemeral.clone(), true, false)?;
    let other_owner = Arc::new(kcoder_config::create_private_temp_dir_in(
        fixture.root.path(),
        "other-account",
    )?);
    let foreign = fixture.engine(
        &fixture.workspace,
        WorkspaceRuntimeServices::new(&fixture.workspace, "owned-other-account")
            .with_private_client_storage(other_owner),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(foreign.clone(), false, false)?;
    for hidden in [
        ephemeral.session_id(),
        foreign.session_id(),
        "never-recorded".into(),
    ] {
        let error = fixture
            .read(&source, json!({"threadId": hidden}))
            .await
            .unwrap_err();
        assert!(error.contains("session_read_not_found"), "{error}");
    }
    let tool = source.active_tool_registry().get("ReadSession").unwrap();
    let own = tool
        .call(
            json!({"threadId": source.session_id()}),
            &ToolContext::new(source.state.clone()),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(own.contains("session_read_self"), "{own}");
    let remote = json!({"threadId":"remote-thread","targetAddress":{
        "targetId":"other-device","workspaceId":"w","threadId":"remote-thread"}});
    let error = tool
        .call(remote, &ToolContext::new(source.state.clone()))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("session_read_unsupported_target"), "{error}");
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn cross_workspace_reads_follow_the_target_owner_policy() -> anyhow::Result<()> {
    if !owned_case("cross_workspace_reads_follow_the_target_owner_policy")? {
        return Ok(());
    }
    use kcoder_config::SessionReadAccess;
    let mut fixture = Fixture::new()?;
    let other = fixture.root.path().join("other-workspace");
    std::fs::create_dir(&other)?;
    let peer = fixture.engine(
        &other,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    peer.state
        .add_message(Message::assistant_text("来自另一个工作区的答复"));
    peer.state.save_history()?;
    let saved_id = peer.session_id();
    drop(peer);
    let resident = fixture.engine(
        &other,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    fixture.insert(resident.clone(), false, false)?;
    for (access, expected) in [
        (
            SessionReadAccess::SameProject,
            Some("session_read_other_project"),
        ),
        (SessionReadAccess::None, Some("session_read_not_permitted")),
        (SessionReadAccess::SameAccount, None),
    ] {
        let source = fixture.reader(&fixture.workspace.clone(), access)?;
        fixture.insert(source.clone(), false, false)?;
        for target in [saved_id.clone(), resident.session_id()] {
            let result = fixture.read(&source, json!({"threadId": target})).await;
            match expected {
                Some(code) => {
                    let error = result.unwrap_err();
                    assert!(error.contains(code), "{access:?} {error}");
                }
                None => {
                    let text = result.map_err(anyhow::Error::msg)?;
                    assert!(text.contains("位于同一主机的其他工作区"), "{text}");
                }
            }
        }
    }
    fixture.shutdown().await;
    Ok(())
}

struct StreamingModel;
impl Provider for StreamingModel {
    fn name(&self) -> &'static str {
        "owned-read-session-streaming"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        // Never finishes, so the target's turn stays active while it is read.
        Ok(Box::pin(futures::stream::pending()))
    }
}

#[tokio::test]
async fn running_conversation_includes_its_in_progress_turn_without_side_effects()
-> anyhow::Result<()> {
    if !owned_case("running_conversation_includes_its_in_progress_turn_without_side_effects")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        Arc::new(StreamingModel),
    )?;
    peer.state
        .add_message(Message::user_text("运行中的问题：请总结进度"));
    peer.state.save_history()?;
    fixture.insert(peer.clone(), false, false)?;
    let peer_id = peer.session_id();
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = peer.run_turn_stream(&prompt);
    let identity = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(Some(identity)) = peer.owned_turn_observer().current_identity() {
                break identity;
            }
            tokio::select! {
                _ = stream.next() => {}
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }
    })
    .await?;
    let turn_state = fixture.manager.turn_state(&peer_id).unwrap();
    for delta in ["正在生成", "的部分答复 token=abcd1234efgh"] {
        turn_state.observe_live_assistant(
            &identity,
            &kcoder_engine::EngineEvent::AssistantTextDelta(delta.into()),
        );
    }
    let history = peer.state.history_path().unwrap();
    let before = std::fs::read(&history)?;
    let lease_target = peer.session_lease_target();
    let text = fixture
        .read(&source, json!({"threadId": peer_id}))
        .await
        .map_err(anyhow::Error::msg)?;
    assert!(text.contains("运行中的问题：请总结进度"), "{text}");
    assert!(text.contains("进行中（内容未完成）"), "{text}");
    assert!(text.contains("助手（正在生成，尚未完成）："));
    assert!(text.contains("正在生成的部分答复"));
    assert!(!text.contains("abcd1234efgh"), "live text is redacted too");
    assert!(text.contains("来源：当前已加载的会话"));
    assert_eq!(
        peer.owned_turn_observer().current_identity().ok().flatten(),
        Some(identity.clone()),
        "the target's turn keeps running"
    );
    assert!(
        fixture
            .manager
            .lease(&peer_id)
            .is_some_and(|lease| lease.matches_target(&lease_target)),
        "the target keeps its own lease"
    );
    assert_eq!(std::fs::read(&history)?, before, "no history write");
    // A message boundary commits text to history, so the mirror is cleared.
    turn_state.observe_live_assistant(&identity, &kcoder_engine::EngineEvent::AssistantMessageDone);
    assert!(turn_state.live_assistant_text(&identity).is_none());
    drop(stream);
    fixture.shutdown().await;
    Ok(())
}
