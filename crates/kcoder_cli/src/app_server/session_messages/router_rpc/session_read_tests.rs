// Routed ReadSession on the destination's real private RPC owner. The source is a
// different runtime target proven only by the router's private route proof.
use super::*;
use kcoder_types::{ContentBlock, Message};

fn foreign_source() -> PeerRouterIdentityV1 {
    PeerRouterIdentityV1 {
        target_id: "other-runtime-target".into(),
        workspace_id: "other-workspace".into(),
        principal: kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        public_key: vec![7; 32],
        identity_epoch: "other-epoch".into(),
    }
}

fn set_read_access(root: &tempfile::TempDir, access: &str) {
    PrivateDirectory::open_existing(&root.path().join("profile"))
        .unwrap()
        .atomic_replace(
            OsStr::new("settings.json"),
            format!(r#"{{"cross_session_messages":{{"enabled":true,"wake_idle":false,"read_access":"{access}"}}}}"#)
                .as_bytes(),
        )
        .unwrap();
}

/// A saved conversation in the destination's own client storage, never loaded.
fn saved_conversation(root: &tempfile::TempDir) -> (String, std::path::PathBuf) {
    let workspace = dunce::canonicalize(root.path().join("workspace")).unwrap();
    let state = kcoder_state::AppState::new(&workspace);
    let id = state.session_id();
    let history = kcoder_state::session_dir_path(workspace.join("client-sessions"), &id)
        .join(format!("{id}.jsonl"));
    state.with_history_path(&history);
    state.add_message(Message::user_text("远端问题：构建在哪一步失败？"));
    state.add_message(Message::Assistant {
        content: vec![
            ContentBlock::Thinking {
                thinking: "REMOTE-PRIVATE-REASONING".into(),
                signature: String::new(),
            },
            ContentBlock::Text {
                text: "在打包步骤，token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 已失效。".into(),
            },
        ],
        usage: None,
    });
    state.save_history().unwrap();
    (id, history)
}

fn read(rpc: &RouterRpc, thread_id: &str) -> Result<Value> {
    let own = rpc.service.identity()?;
    let mut envelope = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": router::method::READ,
        "params": {
            "sourceThreadId": "remote-source",
            "read": {"threadId": thread_id, "targetAddress": rpc.service.address(thread_id)?, "turns": 10}
        },
    });
    envelope[PRIVATE_AGENT_MESSAGE_ROUTE_FIELD] = serde_json::to_value(PrivatePeerRouteProofV1 {
        version: 1,
        purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
        authorization_id: "owned-read-route".into(),
        source: foreign_source(),
        destination: own,
    })?;
    let request = PrivatePeerRouterRequest::decode(&serde_json::to_string(&envelope)?)
        .map_err(anyhow::Error::msg)?;
    rpc.prepare(request, &ThreadManager::default())?.execute()
}

#[test]
fn a_second_runtime_target_reads_only_when_the_owner_allows_it_now() {
    let (root, rpc) = fixture(true, true);
    let capabilities = call(&rpc, router::method::CAPABILITIES, json!({})).unwrap();
    assert!(
        capabilities["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!(CAPABILITY_SESSION_READ_V1))
    );
    let (id, history) = saved_conversation(&root);
    let before = std::fs::read(&history).unwrap();

    // Default same_project: another runtime target can never prove the same project.
    assert_eq!(
        read(&rpc, &id).unwrap(),
        json!({"refused": "session_read_other_project"})
    );

    set_read_access(&root, "same_account");
    let outcome = read(&rpc, &id).unwrap();
    let result: SessionReadOutcome = serde_json::from_value(outcome.clone()).unwrap();
    let SessionReadOutcome::Read { result } = result else {
        panic!("expected a read window, got {outcome}");
    };
    assert_eq!(result.thread_id, id);
    assert_eq!(result.address, Some(rpc.service.address(&id).unwrap()));
    assert!(!result.resident && !result.other_target);
    let text = serde_json::to_string(&result).unwrap();
    assert!(text.contains("远端问题：构建在哪一步失败？"), "{text}");
    assert!(text.contains("在打包步骤"), "{text}");
    for hidden in ["REMOTE-PRIVATE-REASONING", "ghp_abcdefghijklmnopqrstuvwxyz"] {
        assert!(!text.contains(hidden), "leaked {hidden}: {text}");
    }
    assert!(
        serde_json::to_vec(&result).unwrap().len()
            <= crate::app_server::session_discovery::routed_read::MAX_ROUTED_READ_BYTES
    );
    assert_eq!(
        read(&rpc, "missing-conversation").unwrap(),
        json!({"refused": "session_read_not_found"})
    );

    // The next read observes a revoked policy; no earlier allow is reused.
    set_read_access(&root, "none");
    assert_eq!(
        read(&rpc, &id).unwrap(),
        json!({"refused": "session_read_not_permitted"})
    );
    assert_eq!(
        std::fs::read(&history).unwrap(),
        before,
        "reads never write"
    );
}
