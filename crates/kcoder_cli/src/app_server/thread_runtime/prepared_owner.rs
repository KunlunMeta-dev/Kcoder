//! A passive owner retains the original resume and lease without an Engine or Hooks.
use super::*;
use crate::app_server::{
    PreparedThreadResume,
    integrations::core::runtime_driver::NativeOriginalTaskConfiguration,
    recorded_settings_template_path, recorded_thread_permission_mode_at_creation,
    transcript_projection::{prepare_persisted_thread_resume, validate_thread_id},
};
use anyhow::{Result, ensure};

pub(in crate::app_server) enum TaskOwnerPresence {
    Unowned,
    Prepared { operation_id: String },
    Resident,
}

/// A passive lease cannot outlive its actual source consent or binding version.
/// This private witness supplies no Engine, execution or background authority.
pub(in crate::app_server) trait PreparedThreadOwnerFence:
    Send + Sync
{
    fn verify(&self) -> Result<()>;
    fn allows_ui_resume(&self) -> bool {
        false
    }
    fn defaults_to_background(&self) -> bool {
        false
    }
}

pub(in crate::app_server) struct PreparedThreadOwner {
    thread_id: String,
    operation_id: String,
    resume: PreparedThreadResume,
    fence: Arc<dyn PreparedThreadOwnerFence>,
}
impl PreparedThreadOwner {
    pub(in crate::app_server) fn capture(
        workspace: &QueryEngine,
        thread_id: &str,
        operation_id: &str,
        fence: Arc<dyn PreparedThreadOwnerFence>,
    ) -> Result<Self> {
        fence.verify()?;
        validate_thread_id(thread_id)?;
        ensure!(
            !operation_id.is_empty()
                && operation_id.len() <= 256
                && !operation_id.chars().any(char::is_control),
            "TASK_OWNER_OPERATION_INVALID"
        );
        let _lifecycle = crate::app_server::thread_metadata::try_acquire_thread_lifecycle_locks(
            workspace,
            &[thread_id],
        )?;
        let settings_template = recorded_settings_template_path(workspace, thread_id)?;
        let permission_mode_at_creation =
            recorded_thread_permission_mode_at_creation(workspace, thread_id)?;
        let (prepared, lease, client_turn_count) =
            prepare_persisted_thread_resume(workspace, thread_id)?;
        ensure!(
            !prepared.has_legacy_channel_source(),
            "TASK_OWNER_LEGACY_SOURCE_REQUIRES_MIGRATION"
        );
        // This witness verifies the same held kernel object; it never clones the lease.
        lease.native_witness()?.verify_target(lease.target())?;
        fence.verify()?;
        // Preferences are changed only by the ordinary setting API after a
        // resident restoration. A prepared grant remains an authorization fact.
        Ok(Self {
            thread_id: thread_id.into(),
            operation_id: operation_id.into(),
            resume: PreparedThreadResume::Persisted {
                prepared: Box::new(prepared),
                lease,
                client_turn_count,
                settings_template,
                permission_mode_at_creation,
            },
            fence,
        })
    }
}
impl ThreadManager {
    /// Background lifetime is a revocable policy over the current resident,
    /// not a transfer of the task's State or SessionLease to a second owner.
    pub(in crate::app_server) fn retain_resident_background_lifetime(
        &mut self,
        native: &super::super::integrations::core::NativeIntegrationContext,
        thread: &str,
        fence: Arc<dyn PreparedThreadOwnerFence>,
    ) -> Result<()> {
        native.verify()?;
        fence.verify()?;
        ensure!(
            fence.allows_ui_resume(),
            "TASK_BACKGROUND_AUTHORIZATION_REQUIRED"
        );
        let runtime = self
            .runtimes
            .get_mut(thread)
            .ok_or_else(|| anyhow::anyhow!("ORIGINAL_TASK_OWNER_REQUIRED"))?;
        NativeOriginalTaskConfiguration::verify_lifetime_owner(
            native,
            &runtime.engine,
            &runtime.lease,
            runtime.original_task_configuration.as_deref(),
        )?;
        fence.verify()?;
        // Revision zero is the legacy/default preference. An explicit user
        // compatibility setting write always increments it.
        if runtime.engine.state.session_lifetime().revision == 0 {
            runtime.engine.state.set_session_lifetime(
                0,
                kcoder_types::session_lifetime::SessionLifetimeMode::Background,
            )?;
        }
        runtime
            .background_followups
            .session_activity
            .retain_background_authority(fence.clone());
        runtime.background_followups.notify.notify_waiters();
        runtime.background_lifetime = Some(fence);
        Ok(())
    }

    pub(in crate::app_server) fn has_background_lifetime(&self, thread: &str) -> bool {
        self.has_background_prepared_owner(thread)
            || self
                .runtimes
                .get(thread)
                .and_then(|runtime| runtime.background_lifetime.as_ref())
                .is_some_and(|fence| fence.allows_ui_resume() && fence.verify().is_ok())
    }

    pub(in crate::app_server) fn has_background_prepared_owner(&self, thread: &str) -> bool {
        self.prepared_owners
            .get(thread)
            .is_some_and(|owner| owner.fence.allows_ui_resume() && owner.fence.verify().is_ok())
    }
    pub(in crate::app_server) fn task_owner_presence(&self, thread_id: &str) -> TaskOwnerPresence {
        if self.runtimes.contains_key(thread_id) {
            TaskOwnerPresence::Resident
        } else if let Some(owner) = self.prepared_owners.get(thread_id) {
            TaskOwnerPresence::Prepared {
                operation_id: owner.operation_id.clone(),
            }
        } else {
            TaskOwnerPresence::Unowned
        }
    }
    pub(in crate::app_server) fn retain_prepared_owner(
        &mut self,
        owner: PreparedThreadOwner,
    ) -> Result<()> {
        owner.fence.verify()?;
        ensure!(
            !self.runtimes.contains_key(&owner.thread_id)
                && !self.prepared_owners.contains_key(&owner.thread_id),
            "TASK_OWNER_ALREADY_HELD"
        );
        ensure!(
            self.runtimes.len() + self.prepared_owners.len() < self.resident_limit,
            "TASK_OWNER_CAPACITY"
        );
        self.prepared_owners.insert(owner.thread_id.clone(), owner);
        Ok(())
    }
    pub(in crate::app_server) fn take_prepared_owner(
        &mut self,
        workspace: &QueryEngine,
        thread_id: &str,
    ) -> Result<Option<PreparedThreadResume>> {
        let Some(owner) = self.prepared_owners.remove(thread_id) else {
            return Ok(None);
        };
        // Explicit normal resume may still acquire a fresh original lease after
        // this expired handoff is dropped; it cannot consume stale consent.
        if owner.fence.verify().is_err() {
            return Ok(None);
        }
        let _lifecycle = crate::app_server::thread_metadata::try_acquire_thread_lifecycle_locks(
            workspace,
            &[thread_id],
        )?;
        let PreparedThreadResume::Persisted { lease, .. } = owner.resume else {
            anyhow::bail!("TASK_OWNER_ORIGINAL_LEASE_REQUIRED")
        };
        let witness = lease.native_witness()?;
        witness.verify_target(lease.target())?;
        let settings_template = recorded_settings_template_path(workspace, thread_id)?;
        let permission_mode_at_creation =
            recorded_thread_permission_mode_at_creation(workspace, thread_id)?;
        let (prepared, lease, client_turn_count) =
            crate::app_server::transcript_projection::prepare_persisted_thread_resume_with_lease(
                workspace, thread_id, lease,
            )?;
        witness.verify_target(lease.target())?;
        owner.fence.verify()?;
        self.resuming_background
            .insert(thread_id.into(), owner.fence.clone());
        Ok(Some(PreparedThreadResume::Persisted {
            prepared: Box::new(prepared),
            lease,
            client_turn_count,
            settings_template,
            permission_mode_at_creation,
        }))
    }
    pub(in crate::app_server) fn prune_prepared_owners(&mut self) {
        // Dropping a passive owner releases only its original SessionLease.
        // Resident Engines and accepted/running turns have separate lifetimes.
        self.prepared_owners
            .retain(|_, owner| owner.fence.verify().is_ok());
        self.resuming_background
            .retain(|_, fence| fence.verify().is_ok());
        // Revocation fences future channel admission at its own PDP boundary.
        // Clearing lifetime policy must not stop a lawful Web client's turn.
        for runtime in self.runtimes.values_mut() {
            if runtime
                .background_lifetime
                .as_ref()
                .is_some_and(|fence| fence.verify().is_err())
            {
                runtime.background_lifetime = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::tests::catalog_list_test_engine;
    use std::sync::atomic::AtomicBool;

    struct CurrentFence(AtomicBool);
    impl CurrentFence {
        fn allowed() -> Arc<Self> {
            Arc::new(Self(AtomicBool::new(true)))
        }
        fn revoke(&self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    impl PreparedThreadOwnerFence for CurrentFence {
        fn verify(&self) -> Result<()> {
            ensure!(self.0.load(Ordering::SeqCst), "FIXTURE_SOURCE_REVOKED");
            Ok(())
        }
    }
    fn original(root: &std::path::Path) -> (QueryEngine, std::path::PathBuf) {
        let engine = catalog_list_test_engine(root);
        let path = root.join(format!("{}.jsonl", engine.session_id()));
        engine.state.with_history_path(&path);
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Original durable input"));
        engine.state.save_history().unwrap();
        (engine, path)
    }

    #[tokio::test]
    async fn background_consent_retains_an_inflight_resident_without_reconfiguring_it() -> Result<()>
    {
        use crate::app_server::integrations::core::runtime_driver::test_support::{
            Fixture, resident,
        };
        use kcoder_types::session_lifetime::SessionLifetimeMode;

        struct BackgroundConsent;
        impl PreparedThreadOwnerFence for BackgroundConsent {
            fn verify(&self) -> Result<()> {
                Ok(())
            }
            fn allows_ui_resume(&self) -> bool {
                true
            }
        }

        let fixture = Fixture::new();
        let (mut manager, engine) = resident(&fixture).await;
        let engine = engine.with_settings_persistence_path(fixture.profile.join("settings.json"));
        let thread = engine.session_id();
        manager.runtimes.get_mut(&thread).unwrap().engine = engine.clone();
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Original input"));
        engine.state.flush_history().await?;
        let history = engine.state.history_path().unwrap();
        let before = std::fs::read(&history)?;
        assert!(manager.original_task_configuration(&thread).is_none());
        let running = manager.runtimes[&thread].turn_state.running.clone();
        running.store(true, Ordering::SeqCst);

        manager.runtimes.get_mut(&thread).unwrap().engine = engine
            .clone()
            .with_settings_persistence_path(fixture.workspace.join("settings.json"));
        let wrong_profile = manager.retain_resident_background_lifetime(
            &fixture.context,
            &thread,
            Arc::new(BackgroundConsent),
        );
        assert_eq!(
            wrong_profile.unwrap_err().to_string(),
            "ORIGINAL_TASK_SCOPE_CHANGED"
        );
        assert!(!manager.has_background_lifetime(&thread));
        assert_eq!(engine.state.session_lifetime().revision, 0);
        manager.runtimes.get_mut(&thread).unwrap().engine = engine
            .clone()
            .with_settings_persistence_path(fixture.profile.join("settings.json"));

        let retained = manager.retain_resident_background_lifetime(
            &fixture.context,
            &thread,
            Arc::new(BackgroundConsent),
        );
        let still_running = running.swap(false, Ordering::SeqCst);
        retained?;

        assert!(still_running);
        assert!(manager.original_task_configuration(&thread).is_none());
        assert!(manager.has_background_lifetime(&thread));
        assert_eq!(
            engine.state.session_lifetime().mode,
            SessionLifetimeMode::Background
        );
        assert!(SessionLease::acquire_existing_history(&history).is_err());
        assert_eq!(std::fs::read(history)?, before);
        Ok(())
    }

    #[tokio::test]
    async fn passive_resume_reads_current_metadata_under_the_same_original_lease() -> Result<()> {
        use kcoder_state::turn_attempt_store::{
            TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
        };
        use kcoder_types::{ModelSelectionMode, TurnAttemptIdentity, TurnAttemptStatus};
        let root = tempfile::tempdir()?;
        let (engine, path) = original(root.path());
        let thread = engine.session_id();
        let identity = TurnAttemptIdentity {
            thread_id: thread.clone(),
            turn_id: "original-completed-turn".into(),
            attempt_id: "original-completed-attempt".into(),
        };
        let directory = engine.session_storage_dir_for(&thread);
        let attempts = TurnAttemptStore::open(&directory, &thread)?;
        attempts.begin(TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        engine
            .state
            .history_attempt_scope(identity.clone())?
            .run(async {
                engine
                    .state
                    .add_message(kcoder_types::Message::assistant_text("Committed answer"));
            })
            .await;
        engine.state.flush_history().await?;
        let uuid = kcoder_state::load_history(&path)?
            .last()
            .unwrap()
            .uuid
            .clone();
        attempts.finish(
            &identity,
            TurnAttemptCompletion {
                status: TurnAttemptStatus::Completed,
                finished_at_ms: 2,
                error: None,
                provider_failure: None,
                partial_output: String::new(),
                partial_output_truncated: false,
                committed_history_uuid: uuid,
            },
        )?;
        let before = std::fs::read(&path)?;
        let stale = kcoder_state::prepare_session_resume(&path)?;
        let owner = PreparedThreadOwner::capture(
            &engine,
            &thread,
            "background-residency",
            CurrentFence::allowed(),
        )?;
        let mut manager = ThreadManager::default();
        manager.retain_prepared_owner(owner)?;
        // Ordinary model configuration updates metadata, not the conversation.
        engine.state.set_model_selection(
            ModelSelectionMode::Explicit,
            Some("original::updated-model".into()),
        )?;
        assert!(
            stale
                .committed_terminal_attempt_history(&directory, &identity)
                .is_err()
        );
        let PreparedThreadResume::Persisted {
            prepared, lease, ..
        } = manager.take_prepared_owner(&engine, &thread)?.unwrap()
        else {
            anyhow::bail!("original persisted resume required")
        };
        let proof = prepared.committed_terminal_attempt_history(&directory, &identity)?;
        assert!(SessionLease::acquire_existing_history(&path).is_err());
        let restored = kcoder_state::AppState::new(root.path());
        restored.apply_prepared_session_resume(*prepared)?;
        proof.verify_restored(&restored)?;
        assert_eq!(
            restored.selected_model().as_deref(),
            Some("original::updated-model")
        );
        assert_eq!(std::fs::read(&path)?, before);
        drop(lease);
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
        Ok(())
    }

    #[test]
    fn passive_resume_rechecks_the_original_workspace_without_replacing_its_lease() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let foreign_root = tempfile::tempdir().unwrap();
        let (foreign, _) = original(foreign_root.path());
        let owner = PreparedThreadOwner::capture(
            &engine,
            &engine.session_id(),
            "original-residency",
            CurrentFence::allowed(),
        )
        .unwrap();
        let mut manager = ThreadManager::default();
        manager.retain_prepared_owner(owner).unwrap();
        assert!(
            manager
                .take_prepared_owner(&foreign, &engine.session_id())
                .is_err()
        );
        assert!(manager.is_empty());
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_resume_keeps_legacy_directory_rules_without_native_admission() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        drop(SessionLease::acquire_existing_history(&path).unwrap());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let before = std::fs::read(&path).unwrap();
        let (_, lease, count) =
            prepare_persisted_thread_resume(&engine, &engine.session_id()).unwrap();
        assert_eq!(count, 1);
        // Native admission still requires its private directory witness.
        assert!(lease.native_witness().is_err());
        assert!(SessionLease::acquire_existing_history(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        drop(lease);
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
    }
    #[test]
    fn passive_owner_uses_the_original_lease_and_creates_no_resident_engine_or_history() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let before = std::fs::read(&path).unwrap();
        let owner = PreparedThreadOwner::capture(
            &engine,
            &engine.session_id(),
            "original-owner-op",
            CurrentFence::allowed(),
        )
        .unwrap();
        assert!(SessionLease::acquire_existing_history(&path).is_err());
        let mut manager = ThreadManager::default();
        manager.retain_prepared_owner(owner).unwrap();
        assert_eq!(manager.resource_counts(), (1, 0));
        assert!(manager.engine(&engine.session_id()).is_none());
        assert!(matches!(
            manager.task_owner_presence(&engine.session_id()),
            TaskOwnerPresence::Prepared { .. }
        ));
        assert!(!manager.has_background_prepared_owner(&engine.session_id()));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let resume = manager
            .take_prepared_owner(&engine, &engine.session_id())
            .unwrap()
            .unwrap();
        assert!(matches!(resume, PreparedThreadResume::Persisted { .. }));
        assert!(SessionLease::acquire_existing_history(&path).is_err());
        drop(resume);
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn live_original_lease_and_missing_history_are_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let original = SessionLease::acquire_existing_history(&path).unwrap();
        assert!(
            PreparedThreadOwner::capture(
                &engine,
                &engine.session_id(),
                "contender",
                CurrentFence::allowed()
            )
            .is_err()
        );
        drop(original);
        std::fs::remove_file(&path).unwrap();
        assert!(
            PreparedThreadOwner::capture(
                &engine,
                &engine.session_id(),
                "missing",
                CurrentFence::allowed()
            )
            .is_err()
        );
        assert!(!path.exists());
    }
    #[test]
    fn passive_slots_are_bounded_and_drain_releases_only_their_original_lease() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let owner = PreparedThreadOwner::capture(
            &engine,
            &engine.session_id(),
            "retained",
            CurrentFence::allowed(),
        )
        .unwrap();
        let mut manager = ThreadManager::with_resident_limit(1);
        manager.retain_prepared_owner(owner).unwrap();
        assert!(manager.reserve_capacity().is_err());
        assert!(!manager.is_empty());
        assert!(manager.drain().is_empty());
        assert!(manager.is_empty());
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
    }

    #[test]
    fn revoked_source_cannot_capture_or_retain_an_original_handoff() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let before = std::fs::read(&path).unwrap();
        let fence = CurrentFence::allowed();
        fence.revoke();
        assert!(
            PreparedThreadOwner::capture(&engine, &engine.session_id(), "rejected", fence).is_err()
        );
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
        let fence = CurrentFence::allowed();
        let owner =
            PreparedThreadOwner::capture(&engine, &engine.session_id(), "racing", fence.clone())
                .unwrap();
        fence.revoke();
        let mut manager = ThreadManager::default();
        assert!(manager.retain_prepared_owner(owner).is_err());
        assert!(manager.is_empty());
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn resume_drops_a_revoked_handoff_instead_of_consuming_stale_consent() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = original(root.path());
        let before = std::fs::read(&path).unwrap();
        let fence = CurrentFence::allowed();
        let owner =
            PreparedThreadOwner::capture(&engine, &engine.session_id(), "prepared", fence.clone())
                .unwrap();
        let mut manager = ThreadManager::default();
        manager.retain_prepared_owner(owner).unwrap();
        fence.revoke();
        assert!(
            manager
                .take_prepared_owner(&engine, &engine.session_id())
                .unwrap()
                .is_none()
        );
        assert!(manager.is_empty());
        assert!(SessionLease::acquire_existing_history(&path).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn maintenance_releases_only_invalidated_passive_leases_without_touching_history() {
        let root = tempfile::tempdir().unwrap();
        let (first, first_path) = original(root.path());
        let (second, second_path) = original(root.path());
        let first_before = std::fs::read(&first_path).unwrap();
        let second_before = std::fs::read(&second_path).unwrap();
        let fence = CurrentFence::allowed();
        let mut manager = ThreadManager::default();
        manager
            .retain_prepared_owner(
                PreparedThreadOwner::capture(&first, &first.session_id(), "first", fence.clone())
                    .unwrap(),
            )
            .unwrap();
        manager
            .retain_prepared_owner(
                PreparedThreadOwner::capture(
                    &second,
                    &second.session_id(),
                    "second",
                    CurrentFence::allowed(),
                )
                .unwrap(),
            )
            .unwrap();
        fence.revoke();
        manager.prune_prepared_owners();
        assert!(matches!(
            manager.task_owner_presence(&first.session_id()),
            TaskOwnerPresence::Unowned
        ));
        assert!(matches!(
            manager.task_owner_presence(&second.session_id()),
            TaskOwnerPresence::Prepared { .. }
        ));
        assert!(SessionLease::acquire_existing_history(&first_path).is_ok());
        assert!(SessionLease::acquire_existing_history(&second_path).is_err());
        assert_eq!(manager.resource_counts(), (1, 0));
        assert_eq!(std::fs::read(&first_path).unwrap(), first_before);
        assert_eq!(std::fs::read(&second_path).unwrap(), second_before);
    }
}
