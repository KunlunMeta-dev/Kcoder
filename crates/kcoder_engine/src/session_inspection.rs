//! Observational metadata only: never expose settings documents or prompt bodies.
use super::*;
#[derive(Clone)]
pub(super) struct PreparedRequestObservation {
    session_id: String,
    owner: kcoder_state::AppStateIdentity,
    value: serde_json::Value,
}
impl QueryEngine {
    pub(super) fn record_session_request_measurement(
        &self,
        count: crate::context::tokens::TokenCount,
        budget: &crate::context::budget::ContextBudget,
        turn_driver_id: Option<u64>,
        tool_cycle: usize,
    ) {
        let source = match count.source {
            crate::context::tokens::TokenCountSource::ProviderExact => "provider_exact",
            crate::context::tokens::TokenCountSource::UsageAnchorWithEstimatedDelta => {
                "usage_anchor_with_estimated_delta"
            }
            crate::context::tokens::TokenCountSource::FullRequestEstimate => {
                "full_request_estimate"
            }
        };
        let captured_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let value = serde_json::json!({"tokens":count.tokens,"source":source,"captured_at_ms":captured_at_ms,
            "phase":"prepared_request_preflight","turn_driver_id":turn_driver_id,"tool_cycle":tool_cycle,
            "includes_system_and_tool_schemas":true,"send_status":"not_observed",
            "input_budget_at_capture":budget.hard_input_limit(),"output_reservation_at_capture":budget.reserved_output,
            "remaining_input_at_capture":budget.hard_input_limit().saturating_sub(count.tokens),
            "is_current_instantaneous_occupancy":false});
        if let Ok(mut slot) = self.session_request_observation.lock() {
            *slot = Some(PreparedRequestObservation {
                session_id: self.state.session_id(),
                owner: self.state.inspection_identity(),
                value,
            });
        }
    }
    pub(super) fn session_inspection_observation(&self) -> serde_json::Value {
        let observed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let (budget, configured_limit) = {
            let settings = recover_read_lock(&self.settings, "settings");
            let budget = if settings.context_window_tokens.is_some()
                && settings.context_output_headroom.is_some()
            {
                let value = crate::context::budget::ContextBudget::from_settings(&settings);
                serde_json::json!({"context_window":value.total,"input_budget":value.hard_input_limit(),
                    "configured_system_reservation":value.system,"configured_tools_reservation":value.tools,
                    "output_reservation":value.reserved_output,"hard_input_limit":value.hard_input_limit(),
                    "auto_compact_threshold":value.auto_compact_threshold(),"prefire_threshold":value.prefire_threshold(),"reservations_are_not_measured_cost":true})
            } else {
                serde_json::Value::Null
            };
            (budget, effective_max_concurrent_subagents(&settings))
        };
        let last_request = self
            .session_request_observation
            .lock()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .filter(|snapshot| {
                        snapshot.session_id == self.state.session_id()
                            && snapshot.owner.matches(&self.state)
                    })
                    .map(|snapshot| snapshot.value.clone())
            });
        let usage = self.cumulative_usage();
        let task_counts = self.state.try_session_subagent_activity_counts();
        serde_json::json!({
            "modes":{"plan_active":self.state.plan_mode().is_some(),"arrangement_active":self.is_arrangement_mode_active(),"controls":"Only attached tools are callable; other mode changes require the user or host"},
            "available":true,"sampling":"non_atomic_best_effort","observed_at_ms":observed_at_ms,"source":"current_engine_at_tool_call",
            "context":{"estimated_message_tokens":self.estimated_token_count(),"active_message_count":self.state.message_count(),
                "estimate_source":"active_message_token_estimator_after_compaction_boundary",
                "compaction_boundary_present":self.state.shared_messages_with_revision().0.iter().any(|message| message.origin() == kcoder_types::MessageOrigin::Compaction),
                "instantaneous_full_request_tokens":null,"last_full_request":last_request,
                "excludes_system_and_tool_schema_cost":true,"budget":budget},
            "cumulative_usage":{"scope":"current_engine_lifetime_not_context_occupancy",
                "total_tokens":usage.total_tokens,"input_tokens":usage.input_tokens,"output_tokens":usage.output_tokens,
                "cache_creation_input_tokens":usage.cache_creation_input_tokens,"cache_read_input_tokens":usage.cache_read_input_tokens},
            "subagents":{"session_pending_records":task_counts.map(|v|v.0),
                "session_running_records":task_counts.map(|v|v.1),"record_source":"current_session_parent_owned_tasks",
                "configured_limit":configured_limit,"shared_permit_pool_limit":MAX_CONCURRENT_SUBAGENTS,
                "shared_permit_pool_occupied":MAX_CONCURRENT_SUBAGENTS.saturating_sub(self.subagent_semaphore.available_permits()),
                "pool_scope":"shared_engine_fork_family","records_are_not_permit_usage":true}
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    #[tokio::test]
    async fn mode_observation_reports_state_without_exposing_instructions() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path()).build();
        assert_eq!(engine.session_inspection_observation()["modes"]["plan_active"], false);
        engine.state.enter_plan_mode("PRIVATE_PLAN_INSTRUCTIONS");
        let observation = engine.session_inspection_observation();
        assert_eq!(observation["modes"]["plan_active"], true);
        assert!(!observation.to_string().contains("PRIVATE_PLAN_INSTRUCTIONS"));
    }

    #[tokio::test]
    async fn observation_separates_estimate_budget_usage_and_shared_permits() {
        let root = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.context_window_tokens = Some(32000);
        settings.context_output_headroom = Some(4000);
        settings.context_system_tokens = Some(1000);
        settings.context_tools_tokens = Some(2000);
        settings.max_concurrent_subagents = 3;
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build();
        engine
            .state
            .add_message(Message::user_text("current context"));
        recover_write_lock(&engine.cumulative_usage, "test").input_tokens = 999;
        let mut own = kcoder_state::Task::new("own", "fixture");
        own.kind = kcoder_state::TaskKind::Subagent;
        own.status = kcoder_state::TaskStatus::Running;
        own.parent_session_id = Some(engine.state.session_id());
        engine.state.upsert_task(own);
        let mut other = kcoder_state::Task::new("other", "fixture");
        other.kind = kcoder_state::TaskKind::Subagent;
        other.status = kcoder_state::TaskStatus::Running;
        other.parent_session_id = Some("different-owner".into());
        engine.state.upsert_task(other);
        let permit = engine.acquire_subagent_permit().await.unwrap();
        let value = engine.session_inspection_observation();
        assert_eq!(value["context"]["budget"]["context_window"], 32000);
        assert_eq!(value["context"]["budget"]["output_reservation"], 4000);
        assert_eq!(value["context"]["budget"]["input_budget"], 28000);
        assert!(value["context"]["last_full_request"].is_null());
        assert_eq!(value["cumulative_usage"]["input_tokens"], 999);
        assert_ne!(value["context"]["estimated_message_tokens"], 999);
        assert_eq!(value["subagents"]["configured_limit"], 3);
        assert_eq!(value["subagents"]["session_running_records"], 1);
        assert_eq!(value["subagents"]["shared_permit_pool_occupied"], 1);
        engine.record_session_request_measurement(
            crate::context::tokens::TokenCount {
                tokens: 4567,
                source: crate::context::tokens::TokenCountSource::FullRequestEstimate,
            },
            &engine.context_budget(),
            Some(7),
            2,
        );
        let observed = engine.session_inspection_observation();
        assert_eq!(observed["context"]["last_full_request"]["tokens"], 4567);
        assert_eq!(
            observed["context"]["last_full_request"]["turn_driver_id"],
            7
        );
        assert_eq!(
            observed["context"]["last_full_request"]["includes_system_and_tool_schemas"],
            true
        );
        assert_eq!(
            observed["context"]["last_full_request"]["is_current_instantaneous_occupancy"],
            false
        );
        drop(permit);
        assert_eq!(
            engine.session_inspection_observation()["subagents"]["shared_permit_pool_occupied"],
            0
        );
    }
    #[tokio::test]
    async fn actual_request_preflight_and_new_tool_contexts_share_only_their_snapshot() {
        use kcoder_tools::Tool;
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(
                crate::test_support::providers::RequestRecordingProvider {
                    requests: requests.clone(),
                },
            ))
            .build();
        let events = engine
            .submit_message("inspectable request", &kcoder_permissions::AutoDenyPrompt)
            .await;
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::Error(_))),
            "{events:?}"
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        let first_context = engine.base_tool_context(100_000, 60_000, 40_000, Some(3));
        let result = kcoder_tools::CtxInspectTool
            .call(
                serde_json::json!({"action":"messages","limit":1}),
                &first_context,
            )
            .await
            .unwrap();
        let ContentBlock::Text { text } = &result.content[0] else {
            panic!("JSON response")
        };
        let first: serde_json::Value = serde_json::from_str(text).unwrap();
        let measured = &first["observation"]["context"]["last_full_request"];
        assert!(measured["tokens"].as_u64().unwrap() > 0);
        assert_eq!(measured["phase"], "prepared_request_preflight");
        assert_eq!(measured["includes_system_and_tool_schemas"], true);
        engine
            .state
            .add_message(Message::assistant_text("later output"));
        let next_context = engine.base_tool_context(100_000, 60_000, 40_000, Some(3));
        let result = kcoder_tools::CtxInspectTool
            .call(
                serde_json::json!({"cursor":first["transcript"]["next_cursor"]}),
                &next_context,
            )
            .await
            .unwrap();
        let ContentBlock::Text { text } = &result.content[0] else {
            panic!("JSON response")
        };
        let next: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(next["transcript"]["rows"][0]["text"], "ok");
        assert!(!next["transcript"].to_string().contains("later output"));
    }
}
