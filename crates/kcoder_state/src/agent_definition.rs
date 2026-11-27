use super::*;
use kcoder_types::agent_definition::AgentTaskBinding;

impl AppState {
    pub fn channel_task_source(&self) -> Option<kcoder_types::agent_definition::ChannelTaskSource> {
        self.read_inner().channel_task_source.clone()
    }

    /// Only the Native source installer may assign this durable presentation identity.
    pub fn bind_channel_task_source(
        &self,
        source: kcoder_types::agent_definition::ChannelTaskSource,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !source.channel_id.is_empty() && source.channel_id.len() <= 256,
            "CHANNEL_TASK_SOURCE_INVALID"
        );
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.channel_task_source.as_ref() == Some(&source) {
            return Ok(());
        }
        anyhow::ensure!(
            inner.channel_task_source.is_none()
                && !inner.conversation_started
                && inner.messages.is_empty(),
            "CHANNEL_TASK_SOURCE_IMMUTABLE"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        inner.channel_task_source = Some(source);
        if let Some(path) = inner.session_state_path.clone() {
            let state = session_persistence::PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    session_persistence::prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => session_persistence::write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.channel_task_source = None;
                }
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn agent_definition(&self) -> Option<AgentTaskBinding> {
        self.read_inner().agent_definition.clone()
    }

    pub fn agent_configuration(&self) -> (u64, Option<AgentTaskBinding>) {
        let inner = self.read_inner();
        (
            inner.agent_configuration_revision,
            inner.agent_definition.clone(),
        )
    }

    /// Change the next-turn selection under the original session persistence lock.
    /// This does not mutate an already captured Engine or its accepted attempt.
    pub fn select_agent_definition(
        &self,
        expected_revision: u64,
        binding: Option<AgentTaskBinding>,
    ) -> anyhow::Result<u64> {
        if let Some(binding) = &binding {
            anyhow::ensure!(
                binding.definition.is_valid()
                    && !binding.title.is_empty()
                    && binding.title.len() <= 800
                    && binding.source == kcoder_types::agent_definition::AgentTaskSource::Expert,
                "AGENT_DEFINITION_INVALID"
            );
        }
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            inner.agent_configuration_revision == expected_revision,
            "AGENT_CONFIGURATION_REVISION_CONFLICT"
        );
        anyhow::ensure!(
            inner.channel_task_source.is_none()
                && inner
                    .agent_definition
                    .as_ref()
                    .is_none_or(|binding| binding.source
                        != kcoder_types::agent_definition::AgentTaskSource::Channel),
            "AGENT_LEGACY_CHANNEL_READ_ONLY"
        );
        require_history_source(&inner)?;
        let path = inner
            .session_state_path
            .clone()
            .ok_or_else(|| anyhow::anyhow!("AGENT_TASK_PERSISTENCE_REQUIRED"))?;
        let previous = inner.agent_definition.clone();
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("AGENT_CONFIGURATION_REVISION_OVERFLOW"))?;
        inner.agent_definition = binding;
        inner.agent_configuration_revision = revision;
        let state = session_persistence::PersistedSessionState::from_inner(&inner);
        let result = inner
            .history_source
            .as_ref()
            .unwrap()
            .write_metadata(&path, || {
                session_persistence::prepare_legacy_session_state_write(&path, state.clone())
            });
        if let Err(error) = result {
            if crate::history_store::is_uncertain_mutation(&error) {
                inner.history_write_fault = Some(format!("{error:#}"));
            } else {
                inner.agent_definition = previous;
                inner.agent_configuration_revision = expected_revision;
            }
            return Err(error);
        }
        Ok(revision)
    }

    /// Bind once before execution; callers must resolve the original owner and version.
    pub fn bind_agent_definition(&self, binding: AgentTaskBinding) -> anyhow::Result<()> {
        anyhow::ensure!(
            binding.definition.is_valid()
                && !binding.title.is_empty()
                && binding.title.len() <= 800,
            "AGENT_DEFINITION_INVALID"
        );
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if inner.agent_definition.as_ref() == Some(&binding) {
            return Ok(());
        }
        anyhow::ensure!(
            inner.agent_definition.is_none()
                && !inner.conversation_started
                && inner.messages.is_empty(),
            "AGENT_DEFINITION_IMMUTABLE"
        );
        if inner.history_path.is_some() {
            require_history_source(&inner)?;
        }
        inner.agent_definition = Some(binding);
        if let Some(path) = inner.session_state_path.clone() {
            let state = session_persistence::PersistedSessionState::from_inner(&inner);
            let result = match inner.history_source.as_ref() {
                Some(source) => source.write_metadata(&path, || {
                    session_persistence::prepare_legacy_session_state_write(&path, state.clone())
                }),
                None => session_persistence::write_session_state(&path, &state),
            };
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                } else {
                    inner.agent_definition = None;
                }
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::agent_definition::*;

    #[tokio::test]
    async fn next_turn_selection_cas_survives_restore_and_keeps_the_original_history()
    -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let state = AppState::new(root.path());
        let path = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("original task"));
        state.flush_history().await?;
        let before = std::fs::read(&path)?;
        let binding = AgentTaskBinding {
            owner: kcoder_types::integrations::core::IntegrationOwner {
                account_id: "owner".into(),
                target_id: "target".into(),
                workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
                organization_id: None,
            },
            definition: AgentDefinitionRef {
                id: "expert".into(),
                version: "1".into(),
                definition_sha256: "a".repeat(64),
            },
            title: "Expert".into(),
            source: AgentTaskSource::Expert,
            source_id: None,
        };
        assert_eq!(state.select_agent_definition(0, Some(binding.clone()))?, 1);
        assert!(state.select_agent_definition(0, None).is_err());
        assert_eq!(state.agent_configuration(), (1, Some(binding)));
        assert_eq!(state.select_agent_definition(1, None)?, 2);
        assert_eq!(
            state.session_id(),
            crate::session_persistence::session_id_from_history_path(&path)?
        );
        assert_eq!(std::fs::read(&path)?, before);
        let restored = AppState::new(root.path());
        restored.resume_from_history(&path)?;
        assert_eq!(restored.agent_configuration(), (2, None));
        assert_eq!(restored.messages().len(), 1);
        Ok(())
    }
    #[test]
    fn channel_source_without_expert_is_immutable_and_survives_snapshot() {
        let state = AppState::new("/workspace");
        let source = ChannelTaskSource {
            owner: kcoder_types::integrations::core::IntegrationOwner {
                account_id: "owner".into(),
                target_id: "target".into(),
                workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
                organization_id: None,
            },
            channel_id: "original-feishu".into(),
        };
        state.bind_channel_task_source(source.clone()).unwrap();
        state.bind_channel_task_source(source.clone()).unwrap();
        let mut changed = source.clone();
        changed.channel_id = "another".into();
        assert!(state.bind_channel_task_source(changed).is_err());
        let restored: crate::SessionSnapshot =
            serde_json::from_value(serde_json::to_value(state.snapshot()).unwrap()).unwrap();
        assert_eq!(restored.channel_task_source, Some(source));
        assert!(restored.agent_definition.is_none());
    }

    #[test]
    fn binding_is_immutable_and_old_snapshots_stay_compatible() {
        let state = AppState::new("/workspace");
        let binding = AgentTaskBinding {
            owner: kcoder_types::integrations::core::IntegrationOwner {
                account_id: "owner".into(),
                target_id: "target".into(),
                workspace_id: kcoder_types::integrations::core::IntegrationNullable::Null,
                organization_id: None,
            },
            definition: AgentDefinitionRef {
                id: "expert".into(),
                version: "1".into(),
                definition_sha256: "a".repeat(64),
            },
            title: "Expert".into(),
            source: AgentTaskSource::Expert,
            source_id: None,
        };
        state.bind_agent_definition(binding.clone()).unwrap();
        state.bind_agent_definition(binding.clone()).unwrap();
        let mut changed = binding.clone();
        changed.definition.version = "2".into();
        assert!(state.bind_agent_definition(changed).is_err());
        let mut snapshot = serde_json::to_value(state.snapshot()).unwrap();
        let restored: crate::SessionSnapshot = serde_json::from_value(snapshot.clone()).unwrap();
        assert_eq!(restored.agent_definition, Some(binding));
        snapshot.as_object_mut().unwrap().remove("agent_definition");
        assert!(
            serde_json::from_value::<crate::SessionSnapshot>(snapshot)
                .unwrap()
                .agent_definition
                .is_none()
        );
    }
}
