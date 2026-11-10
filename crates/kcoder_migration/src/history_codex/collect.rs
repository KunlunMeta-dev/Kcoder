use super::*;

pub(super) struct Collection {
    pub entries: Vec<Entry>,
    pub issues: BTreeSet<String>,
    pub paginated: bool,
    pub charged: usize,
    pub source_items: u64,
    pub session_seen: bool,
    pub execution: Option<execution::Scope>,
}
impl Collection {
    pub fn new(records: u64, paginated: bool, include_execution: bool) -> Self {
        Self {
            entries: Vec::new(),
            issues: BTreeSet::new(),
            paginated,
            charged: 0,
            source_items: records,
            session_seen: false,
            execution: include_execution.then(execution::Scope::default),
        }
    }
    pub fn push(
        &mut self,
        record: HistoricalRecord,
        source_index: u32,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let ordinal = record.record;
        ensure!(check(ordinal), "history_selection_cancelled");
        let metadata = record
            .codex
            .as_ref()
            .context("history_selection_adapter_incompatible")?;
        if record
            .diagnostics
            .iter()
            .any(|issue| issue.blocks_continuation)
        {
            self.issues.insert("source_records_require_review".into());
        }
        let kind = match &record.data {
            HistoricalRecordData::Session { history_mode, .. } => {
                self.session_seen = true;
                if ordinal != 0 {
                    self.issues
                        .insert("unexpected_codex_session_metadata".into());
                }
                self.paginated = history_mode.as_deref() == Some("paginated");
                if metadata.history_base.is_some() {
                    self.issues.insert("codex_history_base_unresolved".into());
                }
                Kind::Other
            }
            HistoricalRecordData::Compaction { checkpoint } => {
                let mut replacement = None;
                if let Some(items) = &checkpoint.replacement {
                    let mut selected = Vec::new();
                    for source_item in items {
                        ensure!(check(ordinal), "history_selection_cancelled");
                        let mut item = Item::from_data(
                            ordinal,
                            Some(source_item.index),
                            &source_item.metadata,
                            &source_item.data,
                        );
                        item.location.source_index = source_index;
                        if let Some(execution) = &mut self.execution {
                            execution.capture(&item, &source_item.data, &mut self.charged)?;
                        }
                        self.charged += item.charged_bytes();
                        self.source_items += 1;
                        ensure!(
                            self.charged <= SELECTION_MEMORY_BYTES
                                && self.source_items <= EXTERNAL_HISTORY_MAX_RECORDS,
                            "history_selection_memory_budget_exceeded"
                        );
                        selected.push(item);
                    }
                    replacement = Some(selected);
                }
                Kind::Compaction {
                    bounds_input: checkpoint.replacement.is_some()
                        && checkpoint.window_number.is_some()
                        && (self.paginated || checkpoint.resume_metadata.is_some())
                        && !record
                            .diagnostics
                            .iter()
                            .any(|issue| issue.blocks_continuation),
                    replacement,
                    resume_turn_id: checkpoint.resume_turn_id.clone(),
                }
            }
            HistoricalRecordData::Message { .. } => {
                let mut item = Item::from_data(ordinal, None, metadata, &record.data);
                item.location.source_index = source_index;
                if let Some(execution) = &mut self.execution {
                    execution.capture(&item, &record.data, &mut self.charged)?;
                }
                self.charged += item.charged_bytes();
                Kind::Item(Box::new(item))
            }
            HistoricalRecordData::Boundary {
                source_type,
                rollback_turns: Some(turns),
                ..
            } if source_type == "rollback" => Kind::Rollback(*turns),
            HistoricalRecordData::Event {
                source_type,
                call_id: Some(_),
                outcome: Some(_),
                ..
            } if self.execution.is_some()
                && matches!(source_type.as_str(), "exec_command_end" | "patch_apply_end") =>
            {
                let mut item = Item::from_data(ordinal, None, metadata, &record.data);
                item.location.source_index = source_index;
                self.execution
                    .as_mut()
                    .unwrap()
                    .capture(&item, &record.data, &mut self.charged)?;
                self.charged += item.charged_bytes();
                Kind::Supplemental(Box::new(item))
            }
            HistoricalRecordData::Event { source_type, .. } => match source_type.as_str() {
                "task_started" | "turn_started" => Kind::Start,
                "task_complete" | "turn_complete" => Kind::Complete,
                "turn_aborted" => Kind::Abort,
                "user_message" => Kind::UserEvent,
                _ => Kind::Other,
            },
            HistoricalRecordData::Metadata { source_type, .. } if source_type == "turn_context" => {
                Kind::Context
            }
            HistoricalRecordData::Metadata { source_type, .. }
                if source_type == "inter_agent_communication" =>
            {
                Kind::InterAgent
            }
            _ => Kind::Other,
        };
        self.charged +=
            std::mem::size_of::<Entry>() + record.turn_id.as_ref().map_or(0, String::len);
        ensure!(
            self.charged <= SELECTION_MEMORY_BYTES
                && self.source_items <= EXTERNAL_HISTORY_MAX_RECORDS,
            "history_selection_memory_budget_exceeded"
        );
        self.entries.push(Entry {
            source_index,
            record: ordinal,
            turn_id: record.turn_id,
            kind,
        });
        Ok(())
    }
}
