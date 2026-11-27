//! Resolve App Server ownership and history evidence for project automation.
use super::{
    QueryEngine, thread_creations, thread_history_path, turn_admissions, turn_attempts,
    validate_thread_id,
};
use anyhow::Result;
use kcoder_project_automation::cron_processor::{self, CronExecutionHistory};
use kcoder_state::turn_attempt_store::TurnAttemptRecord;
use kcoder_tools::cron::CronScheduler;
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};

struct History<'a>(&'a QueryEngine);

impl CronExecutionHistory for History<'_> {
    fn created_thread(&self, request_id: &str) -> Result<Option<String>> {
        let Some(record) = thread_creations::lookup(self.0, request_id)? else {
            return Ok(None);
        };
        if record.thread.is_none() {
            return Ok(None);
        }
        thread_history_path(self.0, &record.thread_id)?;
        Ok(Some(record.thread_id))
    }

    fn history_path(&self, thread_id: &str) -> Result<PathBuf> {
        validate_thread_id(thread_id)?;
        thread_history_path(self.0, thread_id)
    }

    fn attempts(&self, thread_id: &str) -> Result<Vec<TurnAttemptRecord>> {
        turn_attempts::records(self.0, thread_id)
    }

    fn bindings(&self, thread_id: &str) -> Result<HashMap<String, String>> {
        turn_admissions::bindings(self.0, thread_id)
    }
}

pub(super) fn process(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    anyhow::ensure!(
        !engine.settings.read().unwrap().training_mode,
        "scheduled tasks are disabled in training mode"
    );
    let scheduler = engine.cron_scheduler();
    let session_id = engine.session_id();
    cron_processor::process(&scheduler, &session_id, &History(engine), method, params)
}

pub(super) fn reconcile_execution(engine: &QueryEngine, scheduler: &CronScheduler) {
    cron_processor::reconcile_execution(scheduler, &History(engine));
}
