use super::*;
use kcoder_types::{ModelSelectionMode, StudioToolSelections, agent_definition::*};

fn expert(version: &str) -> AgentTaskBinding {
    AgentTaskBinding {
        owner: kcoder_types::integrations::core::IntegrationOwner {
            account_id: "owner".into(),
            target_id: "target".into(),
            workspace_id: kcoder_types::integrations::core::IntegrationNullable::Value(
                "project".into(),
            ),
            organization_id: None,
        },
        definition: AgentDefinitionRef {
            id: "original-expert".into(),
            version: version.into(),
            definition_sha256: "a".repeat(64),
        },
        title: "Original expert".into(),
        source: AgentTaskSource::Expert,
        source_id: None,
    }
}

fn tools() -> StudioToolSelections {
    StudioToolSelections {
        kcoder: Some(vec!["Read".into()]),
        kworker: Some(vec![]),
    }
}

#[tokio::test]
async fn inherited_selection_survives_cold_restore_without_copying_history_or_future_expert_changes()
-> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let source = AppState::new(root.path());
    let source_path = root.path().join(format!("{}.jsonl", source.session_id()));
    source.with_history_path(&source_path);
    source.set_model_selection(ModelSelectionMode::Explicit, Some("Provider::Flash".into()))?;
    source.bind_studio_tool_selection_once(tools())?;
    source.bind_agent_definition(expert("1"))?;
    source.add_message(Message::user_text("original task history"));
    source.flush_history().await?;
    let original_history = fs::read(&source_path)?;
    let child = AppState::new(root.path());
    let child_path = root.path().join(format!("{}.jsonl", child.session_id()));
    child.with_history_path(&child_path);
    child.inherit_task_configuration_before_first_message(&source)?;
    assert!(child.messages().is_empty());
    assert!(child.channel_task_source().is_none());
    assert_ne!(child.session_id(), source.session_id());
    // The source may change next-turn selection without changing this new task.
    source.select_agent_definition(0, Some(expert("2")))?;
    source.set_model_selection(ModelSelectionMode::Explicit, Some("Other::Model".into()))?;
    child.materialize_history()?;
    child.flush_history().await?;
    let restored = AppState::new(root.path());
    restored.resume_from_history(&child_path)?;
    assert_eq!(restored.agent_configuration(), (0, Some(expert("1"))));
    assert_eq!(
        restored.model_selection_mode(),
        ModelSelectionMode::Explicit
    );
    assert_eq!(
        restored.selected_model().as_deref(),
        Some("Provider::Flash")
    );
    assert_eq!(restored.studio_tool_selection(), Some(tools()));
    assert!(restored.messages().is_empty());
    assert!(restored.channel_task_source().is_none());
    assert_eq!(fs::read(source_path)?, original_history);
    Ok(())
}

#[test]
fn follows_default_and_absent_expert_preserve_the_selection_intent() -> anyhow::Result<()> {
    let source = AppState::new("/workspace");
    source.set_model_selection(
        ModelSelectionMode::FollowTargetDefault,
        Some("Provider::LastResolved".into()),
    )?;
    let child = AppState::new("/workspace");
    child.inherit_task_configuration_before_first_message(&source)?;
    assert_eq!(
        child.model_selection_mode(),
        ModelSelectionMode::FollowTargetDefault
    );
    assert_eq!(child.selected_model(), source.selected_model());
    assert_eq!(child.agent_configuration(), (0, None));
    assert!(child.studio_tool_selection().is_none());
    Ok(())
}

#[test]
fn task_configuration_metadata_preserves_selection_and_invalidates_the_list_key()
-> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let source = AppState::new(root.path());
    let path = root.path().join(format!("{}.jsonl", source.session_id()));
    source.with_history_path(&path);
    source.bind_agent_definition(expert("1"))?;
    source.set_model_selection(ModelSelectionMode::Explicit, Some("Provider::Flash".into()))?;
    source.add_message(Message::user_text("authoritative configuration"));
    source.save_history()?;
    let history = fs::read(&path)?;
    let original = crate::prepare_session_metadata(&path)?;
    assert_eq!(original.selected_model(), Some("Provider::Flash"));
    assert_eq!(
        original.model_selection_mode(),
        ModelSelectionMode::Explicit
    );
    assert_eq!(original.agent_definition(), Some(&expert("1")));
    source.set_model_selection(
        ModelSelectionMode::FollowTargetDefault,
        Some("Provider::LastResolved".into()),
    )?;
    let after = crate::prepare_session_metadata(&path)?;
    assert_eq!(after.selected_model(), Some("Provider::LastResolved"));
    assert_eq!(
        after.model_selection_mode(),
        ModelSelectionMode::FollowTargetDefault
    );
    assert_eq!(after.timestamps_ms()?, original.timestamps_ms()?);
    assert_ne!(after.list_input_key()?, original.list_input_key()?);
    assert_eq!(fs::read(path)?, history);
    Ok(())
}

#[test]
fn existing_selection_same_state_and_other_workspace_cannot_be_overwritten() -> anyhow::Result<()> {
    let source = AppState::new("/workspace");
    source.bind_agent_definition(expert("1"))?;
    assert!(
        source
            .inherit_task_configuration_before_first_message(&source.clone())
            .is_err()
    );
    for change in 0..5 {
        let child = AppState::new(if change == 4 {
            "/other-workspace"
        } else {
            "/workspace"
        });
        match change {
            0 => child.add_message(Message::user_text("already started")),
            1 => child
                .set_model_selection(ModelSelectionMode::Explicit, Some("Own::Model".into()))?,
            2 => child.bind_studio_tool_selection_once(tools())?,
            3 => child.bind_agent_definition(expert("3"))?,
            _ => {}
        }
        let before = serde_json::to_value(child.snapshot())?;
        assert!(
            child
                .inherit_task_configuration_before_first_message(&source)
                .is_err()
        );
        assert_eq!(serde_json::to_value(child.snapshot())?, before);
    }
    Ok(())
}

#[test]
fn legacy_channel_identity_is_not_a_transferable_ordinary_task_configuration() -> anyhow::Result<()>
{
    for legacy_expert in [false, true] {
        let source = AppState::new("/workspace");
        if legacy_expert {
            let mut binding = expert("1");
            binding.source = AgentTaskSource::Channel;
            source.bind_agent_definition(binding)?;
        } else {
            source.bind_channel_task_source(ChannelTaskSource {
                owner: expert("1").owner,
                channel_id: "original-bot".into(),
            })?;
        }
        let child = AppState::new("/workspace");
        assert!(
            child
                .inherit_task_configuration_before_first_message(&source)
                .is_err()
        );
        assert!(child.agent_definition().is_none());
        assert!(child.channel_task_source().is_none());
        assert!(child.selected_model().is_none());
        assert!(child.messages().is_empty());
    }
    Ok(())
}
