//! Native pre-model binding after the actual private Accepted receipt exists.
use crate::QueryEngine;
use anyhow::{Result, ensure};
use kcoder_state::{AppStateIdentity, HistoryAppendScope};
use kcoder_types::TurnAttemptIdentity;
use std::sync::{Arc, Mutex};

#[async_trait::async_trait]
pub trait NativeTurnAdmissionObserver: Send + Sync {
    async fn accepted(&self, engine: &QueryEngine, identity: &TurnAttemptIdentity) -> Result<()>;
}

struct Accepted {
    identity: TurnAttemptIdentity,
    epoch: HistoryAppendScope,
}
pub(crate) struct NativeTurnAdmission {
    owner: AppStateIdentity,
    observers: Vec<Arc<dyn NativeTurnAdmissionObserver>>,
    accepted: Mutex<Option<Accepted>>,
    registration: tokio::sync::Mutex<()>,
}

impl QueryEngine {
    /// Append a required native callback on this task value, before admission.
    /// A missing or failed callback never becomes permission to start a model.
    pub fn with_native_turn_admission_observer(
        mut self,
        observer: Arc<dyn NativeTurnAdmissionObserver>,
    ) -> Result<Self> {
        let mut observers = Vec::new();
        if let Some(previous) = &self.native_turn_admission {
            ensure!(
                previous.owner.matches(&self.state),
                "NATIVE_TASK_ADMISSION_OWNER_CHANGED"
            );
            ensure!(
                previous
                    .accepted
                    .lock()
                    .map_err(|_| anyhow::anyhow!("NATIVE_TASK_ADMISSION_UNAVAILABLE"))?
                    .is_none(),
                "NATIVE_TASK_ALREADY_ADMITTED"
            );
            observers.extend(previous.observers.iter().cloned());
        }
        ensure!(observers.len() < 16, "NATIVE_TASK_ADMISSION_CAPACITY");
        observers.push(observer);
        self.native_turn_admission = Some(Arc::new(NativeTurnAdmission {
            owner: self.state.inspection_identity(),
            observers,
            accepted: Mutex::new(None),
            registration: tokio::sync::Mutex::new(()),
        }));
        Ok(self)
    }

    pub async fn observe_native_turn_acceptance(
        &self,
        identity: &TurnAttemptIdentity,
    ) -> Result<()> {
        let Some(admission) = &self.native_turn_admission else {
            return Ok(());
        };
        let _registration = admission.registration.lock().await;
        ensure!(
            admission.owner.matches(&self.state)
                && identity.thread_id == self.state.session_id()
                && self.state.current_history_attempt_identity().as_ref() == Some(identity),
            "NATIVE_TASK_ADMISSION_OWNER_CHANGED"
        );
        {
            let accepted = admission
                .accepted
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_TASK_ADMISSION_UNAVAILABLE"))?;
            if let Some(accepted) = accepted.as_ref() {
                ensure!(
                    accepted.identity == *identity && accepted.epoch.matches_current(&self.state),
                    "NATIVE_TASK_ADMISSION_OWNER_CHANGED"
                );
                return Ok(());
            }
        }
        let epoch = self.state.history_attempt_scope(identity.clone())?;
        let started = std::time::Instant::now();
        for observer in &admission.observers {
            let remaining = std::time::Duration::from_secs(5)
                .checked_sub(started.elapsed())
                .ok_or_else(|| anyhow::anyhow!("NATIVE_TASK_ADMISSION_TIMED_OUT"))?;
            tokio::time::timeout(remaining, observer.accepted(self, identity))
                .await
                .map_err(|_| anyhow::anyhow!("NATIVE_TASK_ADMISSION_TIMED_OUT"))?
                .map_err(|_| anyhow::anyhow!("NATIVE_TASK_ADMISSION_UNAVAILABLE"))?;
        }
        ensure!(
            epoch.matches_current(&self.state),
            "NATIVE_TASK_ADMISSION_OWNER_CHANGED"
        );
        *admission
            .accepted
            .lock()
            .map_err(|_| anyhow::anyhow!("NATIVE_TASK_ADMISSION_UNAVAILABLE"))? = Some(Accepted {
            identity: identity.clone(),
            epoch,
        });
        Ok(())
    }

    pub(crate) fn native_turn_admission_ready(&self) -> bool {
        let Some(admission) = &self.native_turn_admission else {
            return true;
        };
        admission.owner.matches(&self.state)
            && admission.accepted.lock().ok().is_some_and(|accepted| {
                accepted
                    .as_ref()
                    .is_some_and(|accepted| accepted.epoch.matches_current(&self.state))
            })
    }
}

#[cfg(test)]
mod tests;
