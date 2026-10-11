//! Engine configuration within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// Replace the default cancel token with an externally-controlled one.
    pub fn with_cancel_token(mut self, token: CancellationToken) -> Self {
        self.cancel_token = token;
        self
    }

    /// Explicitly enable user-settings persistence. Unless called, the engine never infers or writes to a default home directory.
    pub fn with_settings_persistence_path(self, path: PathBuf) -> Self {
        self.state
            .set_usage_history_root(path.parent().map(|parent| parent.join("usage")).as_deref());
        *recover_write_lock(
            &self.settings_persistence_target,
            "settings_persistence_target",
        ) = SettingsPersistenceTarget::UserFile(path);
        self
    }

    /// The host replaces only a candidate turn snapshot; running clones keep their registry/settings.
    pub fn with_host_plugin_runtime(
        mut self,
        mut settings: Settings,
        tools: ToolRegistry,
        plugins: kcoder_plugins::EffectivePluginSnapshot,
    ) -> Result<Self> {
        strip_private_plugin_settings(&mut settings)?;
        self.settings = Arc::new(RwLock::new(settings));
        self.tools = tools;
        self.plugin_snapshot = Arc::new(plugins);
        Ok(self)
    }

    /// Return the user-settings file explicitly configured by the host; None means persistence is disabled for this engine.
    pub fn settings_persistence_path(&self) -> Option<PathBuf> {
        match &*recover_read_lock(
            &self.settings_persistence_target,
            "settings_persistence_target",
        ) {
            SettingsPersistenceTarget::Disabled => None,
            SettingsPersistenceTarget::UserFile(path) => Some(path.clone()),
        }
    }

    /// Write only fields explicitly listed by the caller to the explicit user file.
    ///
    /// The on-disk document is reread while holding the file lock. Project layers,
    /// overlays, and product defaults are never materialized into the user file from
    /// a `Settings` snapshot. In the default Disabled mode this is a no-op success.
    pub async fn persist_settings_fields(&self, settings: Settings, keys: &[&str]) -> Result<()> {
        let _order = self.settings_persistence_order.lock().await;
        self.persist_settings_fields_ordered(settings, keys).await
    }

    pub(super) async fn persist_settings_fields_ordered(
        &self,
        settings: Settings,
        keys: &[&str],
    ) -> Result<()> {
        if keys.is_empty() {
            return Ok(());
        }
        let target = recover_read_lock(
            &self.settings_persistence_target,
            "settings_persistence_target",
        )
        .clone();
        let SettingsPersistenceTarget::UserFile(path) = target else {
            return Ok(());
        };

        let serialized = serde_json::to_value(settings).context("failed to serialize settings")?;
        let mut seen = HashSet::new();
        let mut patches = Vec::with_capacity(keys.len());
        for key in keys {
            if !seen.insert(*key) {
                continue;
            }
            let root = key.split('.').next().unwrap_or_default();
            if matches!(
                root,
                "api_key"
                    | "anthropic_api_key"
                    | "kunlunmeta_api_key"
                    | "openai_api_key"
                    | "local_api_key"
                    | "gemini_api_key"
                    | "grok_api_key"
                    | "stored_provider_credentials"
                    | "credential_overrides"
                    | "provider_proxy_url"
            ) {
                anyhow::bail!("refusing to persist secret or runtime-only setting field '{key}'");
            }
            patches.push(((*key).to_string(), dotted_value(&serialized, key)?.cloned()));
        }

        tokio::task::spawn_blocking(move || {
            update_settings_file(&path, move |document| {
                for (key, value) in patches {
                    if let Some(value) = value {
                        set_dotted_value(document, &key, value)?;
                    } else {
                        remove_dotted_value(document, &key)?;
                    }
                }
                Ok(())
            })
            .map(|_| ())
        })
        .await
        .context("settings persistence task failed")?
    }

    /// Commit a candidate client runtime created by the factory.
    ///
    /// Before this call, the candidate engine creates neither an empty session sidecar nor a structured-memory session.
    pub fn activate_client_session(&self) {
        record_structured_memory_session(&self.memory_manager, &self.state, &self.cwd);
        self.state.commit_session_state();
        if self.state.history_path().is_none() {
            let root = kcoder_state::session_dir_path(
                &self.session_storage_root,
                &self.state.artifact_session_id(),
            );
            if let Err(error) = kcoder_config::PrivateDirectory::open_or_create(&root) {
                warn!("failed to prepare activated client diagnostic root: {error}");
            }
        }
    }

    /// Enable/disable Arrangement orchestrator semantics for this engine.
    pub fn with_arrangement_mode(self, enabled: bool) -> Self {
        self.arrangement_mode.store(enabled, Ordering::SeqCst);
        self
    }

    /// Enable or disable the reduced, configuration-driven Luna tool surface.
    pub fn set_luna_mode(&self, enabled: bool) {
        self.luna_mode.store(enabled, Ordering::SeqCst);
        if enabled {
            recover_write_lock(&self.active_skills, "active_skills")
                .retain(|name| !is_spec_workflow_skill_name(name));
        }
    }

    pub fn is_luna_mode_active(&self) -> bool {
        self.luna_mode.load(Ordering::SeqCst)
    }

    /// Restrict this engine's mutating file tools to the provided paths.
    pub fn with_allowed_write_paths(self, paths: Vec<String>) -> Self {
        *recover_write_lock(&self.allowed_write_paths, "allowed_write_paths") = paths;
        self
    }

    /// Restrict scoped shell execution to prefixes explicitly delegated by
    /// the parent orchestrator.
    pub fn with_allowed_shell_prefixes(self, prefixes: Vec<String>) -> Self {
        *recover_write_lock(&self.allowed_shell_prefixes, "allowed_shell_prefixes") = prefixes;
        self
    }

    pub fn with_block_shell_file_mutation(self, enabled: bool) -> Self {
        self.block_shell_file_mutation
            .store(enabled, Ordering::SeqCst);
        self
    }

    pub fn with_block_dependency_mutation(self, enabled: bool) -> Self {
        self.block_dependency_mutation
            .store(enabled, Ordering::SeqCst);
        self
    }

    pub fn with_shell_isolation_root(self, root: Option<PathBuf>) -> Self {
        *recover_write_lock(&self.shell_isolation_root, "shell_isolation_root") = root;
        self
    }

    pub fn with_verifier_test_policy(
        self,
        minimum_scope: Option<GoalProTestScope>,
        require_raw_exit_code: bool,
    ) -> Self {
        *recover_write_lock(
            &self.verifier_minimum_test_scope,
            "verifier_minimum_test_scope",
        ) = minimum_scope;
        self.verifier_require_raw_exit_code
            .store(require_raw_exit_code, Ordering::SeqCst);
        self
    }

    pub fn with_verifier_baseline_root(self, root: Option<PathBuf>) -> Self {
        *recover_write_lock(&self.verifier_baseline_root, "verifier_baseline_root") = root;
        self
    }

    /// Inject the Goal Pro verifier vote channel; used only by verifier sessions and always None for regular sessions.
    pub(crate) fn with_verifier_vote_channel(
        self,
        channel: Option<kcoder_tools::VerifierVoteChannel>,
    ) -> Self {
        *recover_write_lock(&self.verifier_vote_channel, "verifier_vote_channel") = channel;
        self
    }

    pub(crate) fn with_review_vote_channel(
        self,
        channel: Option<kcoder_tools::ReviewVoteChannel>,
    ) -> Self {
        *recover_write_lock(&self.review_vote_channel, "review_vote_channel") = channel;
        self
    }

    pub fn with_verifier_behavior_delta(self, required: bool) -> Self {
        self.verifier_require_behavior_delta
            .store(required, Ordering::SeqCst);
        self
    }

    /// Enable temporary path hints for hosts that implement their lifecycle cleanup.
    pub fn with_tool_path_previews(mut self, enabled: bool) -> Self {
        self.tool_path_previews = enabled;
        self
    }

    pub(crate) fn with_terminal_verdict_turn(self, enabled: bool) -> Self {
        self.terminal_verdict_turn.store(enabled, Ordering::SeqCst);
        self
    }

    pub(crate) fn with_sandbox(mut self, sandbox: Sandbox) -> Self {
        self.sandbox = Arc::new(sandbox);
        self
    }

    pub(crate) fn with_agent_depth(self, depth: u32) -> Self {
        self.agent_depth.store(depth, Ordering::SeqCst);
        self
    }

    pub(crate) fn with_skill_mutation_actor(
        mut self,
        actor: Option<kcoder_skills::SkillMutationActor>,
    ) -> Self {
        self.skill_mutation_actor = Arc::new(actor);
        self
    }

    pub(crate) fn agent_depth(&self) -> u32 {
        self.agent_depth.load(Ordering::SeqCst)
    }

    /// Override the base tool registry used by sub-agents before role filtering.
    pub fn with_subagent_tools(self, tools: ToolRegistry) -> Self {
        *recover_write_lock(&self.subagent_tools, "subagent_tools") = tools;
        self
    }

    pub(crate) fn with_subagent_system_prompt(mut self, prompt: Option<String>) -> Self {
        self.subagent_system_prompt = Arc::new(prompt.filter(|value| !value.trim().is_empty()));
        self
    }

    pub(crate) fn with_subagent_runtime_control(
        mut self,
        parent_state: AppState,
        agent_id: String,
        transcript_path: PathBuf,
    ) -> Self {
        let expected_background_run = parent_state
            .task(&agent_id)
            .and_then(|task| task.background_run);
        self.subagent_runtime_control = Arc::new(Some(SubagentRuntimeControl {
            expected_background_run,
            parent_state,
            agent_id,
            transcript_path,
            checkpoint_writer: Arc::new(FilesystemSubagentCheckpointWriter),
        }));
        self
    }

    pub(crate) fn subagent_tools(&self) -> ToolRegistry {
        recover_read_lock(&self.subagent_tools, "subagent_tools").clone()
    }

    pub(crate) fn active_subagent_tools_for_mode(&self, arrangement_mode: bool) -> ToolRegistry {
        if arrangement_mode {
            if self.state.session_mode().is_orchestrate() {
                kcoder_tools::orchestrate_subagent_registry()
            } else {
                kcoder_tools::arrangement_subagent_registry()
            }
        } else {
            self.subagent_tools()
        }
    }

    pub(crate) fn active_subagent_tools(&self) -> ToolRegistry {
        self.active_subagent_tools_for_mode(self.is_arrangement_mode_active())
    }

    pub(crate) fn is_arrangement_mode_active(&self) -> bool {
        self.state.session_mode().is_orchestrate()
            || self.arrangement_mode.load(Ordering::SeqCst)
            || self
                .state
                .goal()
                .map(|goal| goal.status.is_active() && goal.mode.is_arrangement())
                .unwrap_or(false)
    }
}

/// Consume only the host-marked appended suffix, preserving the user's exact prefix.
pub(super) fn strip_private_plugin_settings(settings: &mut Settings) -> Result<()> {
    anyhow::ensure!(
        settings.runtime_plugin_mcp_count <= settings.mcp_servers.len(),
        "Invalid host plugin MCP suffix length"
    );
    let public_len = settings.mcp_servers.len() - settings.runtime_plugin_mcp_count;
    settings.mcp_servers.truncate(public_len);
    settings.runtime_plugin_mcp_count = 0;
    Ok(())
}

#[cfg(test)]
mod private_plugin_settings_tests {
    use super::*;
    #[test]
    fn host_suffix_is_private_and_same_named_user_prefix_is_preserved() {
        let server: kcoder_config::McpServerConfig = serde_json::from_value(serde_json::json!({
            "name":"same", "transport":"stdio", "command":"node", "env":{"FOO":"private-test-value"},
            "headers":{"X-Custom":"private-test-value"}
        })).unwrap();
        let mut settings = Settings {
            mcp_servers: vec![server.clone(), server.clone()],
            runtime_plugin_mcp_count: 1,
            ..Default::default()
        };
        strip_private_plugin_settings(&mut settings).unwrap();
        assert_eq!(settings.mcp_servers.len(), 1);
        assert_eq!(
            serde_json::to_value(&settings.mcp_servers[0]).unwrap(),
            serde_json::to_value(&server).unwrap()
        );
        strip_private_plugin_settings(&mut settings).unwrap();
        assert_eq!(settings.mcp_servers.len(), 1);
        assert!(
            serde_json::to_value(&settings)
                .unwrap()
                .get("runtime_plugin_mcp_count")
                .is_none()
        );
        let mut invalid = Settings {
            runtime_plugin_mcp_count: 1,
            ..Default::default()
        };
        assert!(strip_private_plugin_settings(&mut invalid).is_err());
        let externally_supplied: Settings =
            serde_json::from_value(serde_json::json!({"runtime_plugin_mcp_count": 1})).unwrap();
        assert_eq!(externally_supplied.runtime_plugin_mcp_count, 0);
    }
}
