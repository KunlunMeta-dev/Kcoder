//! Display throttling never throttles the native cancellation checkpoints.
use super::*;
use kcoder_migration::history_jobs::HistoryImportEvent;
use serde_json::json;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct Progress {
    last: Option<(u8, Instant)>,
}
impl Progress {
    pub fn history(&mut self, guide: &Guide<'_>, action: &str, event: HistoryImportEvent) -> bool {
        if guide.cancelled.load(Ordering::Acquire) {
            return false;
        }
        let (phase, detail) = match event {
            HistoryImportEvent::Capture {
                processed_bytes,
                total_bytes,
            } => (
                0,
                json!({"phase":"capture","processedBytes":processed_bytes,"totalBytes":total_bytes}),
            ),
            HistoryImportEvent::Archive(progress) => {
                use kcoder_types::external_history::ExternalHistoryPhase;
                let (key, stage) = match progress.phase {
                    ExternalHistoryPhase::CopyingOriginal => (1, "copying_original"),
                    ExternalHistoryPhase::ReadingOriginal => (2, "reading_original"),
                    ExternalHistoryPhase::Decoding => (3, "decoding"),
                    ExternalHistoryPhase::Copying => (4, "copying"),
                    ExternalHistoryPhase::Indexing => (5, "indexing"),
                    ExternalHistoryPhase::Verifying => (6, "verifying"),
                };
                (
                    key,
                    json!({"phase":"archive","stage":stage,"processedBytes":progress.processed_bytes,"totalBytes":progress.total_bytes}),
                )
            }
            HistoryImportEvent::Normalize(progress) => {
                (7, json!({"phase":"normalize","progress":progress}))
            }
        };
        if self.last.is_some_and(|(previous, at)| {
            previous == phase && at.elapsed() < Duration::from_millis(250)
        }) {
            return true;
        }
        self.last = Some((phase, Instant::now()));
        guide
            .io
            .state("progress", &json!({"actionId":action,"history":detail}))
            .is_ok()
    }
}
