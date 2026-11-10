//! Original task identity and configuration remain in the single Core runtime.
use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn original_ui_configuration_survives_its_client_without_granting_another_source()
    -> anyhow::Result<()> {
        use crate::app_server::{
            ConnectionState,
            integrations::{connectivity::task_ui, core::runtime_driver::test_support::Fixture},
        };
        let native = Fixture::new();
        let mut runtime =
            test_support::test_runtime("original", &native.workspace.join("placeholder.jsonl"));
        let read = kcoder_tools::Tool::name(&kcoder_tools::FileReadTool);
        let engine = runtime
            .engine()
            .with_settings_persistence_path(native.profile.join("settings.json"))
            .with_turn_tools(kcoder_tools::default_registry())
            .with_native_tool_ceiling(std::slice::from_ref(&read))?;
        let thread = engine.session_id();
        let history = native.workspace.join(format!("{thread}.jsonl"));
        runtime.lease = SessionLease::acquire(&history)?;
        engine.state.with_history_path(&history);
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Original task"));
        engine.state.save_history()?;
        let bytes = std::fs::read(&history)?;
        runtime.engine = engine.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let ui = || -> anyhow::Result<ConnectionState> {
            Ok(ConnectionState {
                initialized: true,
                integration_task_capability_scope_v1: true,
                thread_runtime_handoff_v1: true,
                interaction_binding_v1: true,
                integration_context: Some(native.context.recapture_for_owned_service()?),
                ..Default::default()
            })
        };
        let first = ui()?;
        task_ui::retain_original_configuration(&first, &mut manager, &thread)?;
        let original = manager.original_task_configuration(&thread).unwrap();
        first.input_ended.cancel();
        assert!(task_ui::prepare_resident_input(&first, &manager, &thread).is_err());
        let second = ui()?;
        task_ui::retain_original_configuration(&second, &mut manager, &thread)?;
        assert!(Arc::ptr_eq(
            &original,
            &manager.original_task_configuration(&thread).unwrap()
        ));
        let candidate = task_ui::prepare_resident_input(&second, &manager, &thread)?.unwrap();
        assert!(candidate.state.shares_state_with(&engine.state));
        assert_eq!(candidate.active_tool_registry().names(), vec![read]);
        let foreign = Fixture::new();
        let mut denied = ui()?;
        denied.integration_context = Some(foreign.context.recapture_for_owned_service()?);
        assert!(task_ui::prepare_resident_input(&denied, &manager, &thread).is_err());
        denied.integration_context = Some(native.context.recapture_for_owned_service()?);
        denied.native_source_dispatch = true;
        assert!(task_ui::retain_original_configuration(&denied, &mut manager, &thread).is_err());
        assert_eq!(std::fs::read(&history)?, bytes);
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }

    #[tokio::test]
    async fn original_configuration_keeps_its_ceiling_and_rejects_foreign_state_and_scope()
    -> anyhow::Result<()> {
        use crate::app_server::integrations::core::runtime_driver::{
            NativeOriginalTaskConfiguration, test_support::Fixture,
        };
        let native = Fixture::new();
        let other = Fixture::new();
        let mut runtime =
            test_support::test_runtime("original", &native.workspace.join("placeholder.jsonl"));
        let read = kcoder_tools::Tool::name(&kcoder_tools::FileReadTool);
        let engine = runtime
            .engine()
            .with_settings_persistence_path(native.profile.join("settings.json"))
            .with_turn_tools(kcoder_tools::default_registry())
            .with_native_tool_ceiling(std::slice::from_ref(&read))?;
        let thread = engine.session_id();
        let history = native.workspace.join(format!("{thread}.jsonl"));
        runtime.lease = SessionLease::acquire(&history)?;
        engine.state.with_history_path(&history);
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Original task"));
        engine.state.save_history()?;
        runtime.engine = engine.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let result = (|| -> anyhow::Result<()> {
            let original =
                NativeOriginalTaskConfiguration::resident(&native.context, &manager, &thread)?;
            manager.retain_original_task_configuration(
                &native.context,
                &thread,
                original.clone(),
            )?;
            let restricted = engine
                .clone()
                .with_native_tool_ceiling(&[])?
                .with_required_native_host_source_admission()?;
            manager.replace_host_turn_engine(&thread, restricted.clone())?;
            assert!(restricted.active_tool_registry().names().is_empty());
            let recovered = original.for_resident(
                &native.context,
                &restricted,
                manager.lease(&thread).unwrap(),
            )?;
            assert_eq!(recovered.active_tool_registry().names(), vec![read.clone()]);
            assert!(recovered.state.shares_state_with(&engine.state));
            assert!(
                manager
                    .replace_host_turn_engine(&thread, recovered.clone())
                    .is_err()
            );
            let registration = manager
                .turn_state(&thread)
                .unwrap()
                .activity_gate
                .clone()
                .try_lock_owned()?;
            assert!(
                manager
                    .restore_original_task_engine_during_registration(
                        &thread,
                        &other.context,
                        &registration,
                    )
                    .is_err()
            );
            let restored = manager.restore_original_task_engine_during_registration(
                &thread,
                &native.context,
                &registration,
            )?;
            assert_eq!(restored.active_tool_registry().names(), vec![read.clone()]);
            assert!(!restored.native_input_requires_source_admission());
            drop(registration);
            assert!(
                original
                    .for_resident(&other.context, &restricted, manager.lease(&thread).unwrap())
                    .is_err()
            );
            let mut foreign = engine.clone();
            foreign.state = kcoder_state::AppState::new(&native.workspace);
            foreign.state.resume_from_history(&history)?;
            assert!(
                manager
                    .lease(&thread)
                    .unwrap()
                    .matches_target(&foreign.session_lease_target())
            );
            assert!(
                original
                    .for_resident(&native.context, &foreign, manager.lease(&thread).unwrap())
                    .is_err()
            );
            assert!(
                NativeOriginalTaskConfiguration::resident(&other.context, &manager, &thread)
                    .is_err()
            );
            Ok(())
        })();
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        result
    }

    #[tokio::test]
    async fn another_state_with_the_same_thread_and_history_cannot_replace_the_core_owner()
    -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let _owned = kcoder_config::PrivateDirectory::open_existing(root.path())?
            .create_private_child(std::ffi::OsStr::new("original-task"))?;
        let workspace = root.path().join("original-task");
        let mut runtime =
            test_support::test_runtime("original", &workspace.join("placeholder.jsonl"));
        let engine = runtime.engine();
        let history = workspace.join(format!("{}.jsonl", engine.session_id()));
        runtime.lease = SessionLease::acquire(&history)?;
        engine.state.with_history_path(&history);
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Original task"));
        engine.state.save_history()?;
        let thread = engine.session_id();
        let original_identity = engine.state.inspection_lifecycle_identity();
        let mut candidate = engine.clone();
        let other = kcoder_state::AppState::new(&workspace);
        other.resume_from_history(&history)?;
        candidate.state = other;
        assert_eq!(candidate.session_id(), thread);
        assert!(!original_identity.matches(&candidate.state));
        assert!(
            runtime
                .lease
                .matches_target(&candidate.session_lease_target())
        );
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let replaced = manager.replace_host_turn_engine(&thread, candidate);
        let original_retained = original_identity.matches(&manager.engine(&thread).unwrap().state);
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        assert!(
            replaced.is_err(),
            "A matching file path cannot replace the actual Core State"
        );
        assert!(original_retained);
        Ok(())
    }
    #[tokio::test]
    async fn host_engine_replacement_rejects_a_recreated_input_context() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let mut runtime =
            test_support::test_runtime("protected-input", &root.path().join("placeholder.jsonl"));
        let engine = runtime
            .engine()
            .with_native_input_only_context("original input".into(), 128)?;
        let thread = engine.session_id();
        let history = root.path().join(format!("{thread}.jsonl"));
        runtime.lease = SessionLease::acquire(&history)?;
        engine.state.with_history_path(&history);
        let recreated = engine
            .clone()
            .with_native_input_only_context("original input".into(), 128)?;
        runtime.engine = engine.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let result = (|| -> anyhow::Result<()> {
            manager.replace_host_turn_engine(&thread, engine.clone())?;
            let refused = manager
                .replace_host_turn_engine(&thread, recreated)
                .expect_err("Recreating equivalent input must not replace its protected identity");
            anyhow::ensure!(
                refused.to_string()
                    == "Thread candidate cannot remove its native input attenuation"
            );
            anyhow::ensure!(
                manager
                    .engine(&thread)
                    .unwrap()
                    .preserves_native_input_attenuation_from(&engine)
                    == Some(true)
            );
            Ok(())
        })();
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        result
    }
}
