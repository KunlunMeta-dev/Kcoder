//! Read-triggered constraints use trusted runtime evidence and the already-frozen session scope.
use super::*;
const MARKER: &str = "<imported-instruction-activation id=\"";

impl QueryEngine {
    pub(super) fn attach_imported_instruction_context(&self, output: &mut ToolOutput) {
        if output.is_error {
            return;
        }
        let Some(snapshot) = self.state.imported_context_snapshot_shared() else {
            return;
        };
        let Some(session) = snapshot.instructions.as_ref() else {
            return;
        };
        let Some(settings) = self.settings_persistence_path() else {
            return;
        };
        let Some(profile) = settings.parent() else {
            return;
        };
        if super::imported_context_snapshot::profile_identity(profile)
            .ok()
            .as_deref()
            != Some(snapshot.profile_identity.as_str())
        {
            self.reject_imported_instruction_read(output, "File content was read, but the frozen imported instruction profile binding changed. Restore the original profile before continuing this scoped task.");
            return;
        }
        let mut selected = Vec::new();
        let mut selected_keys = std::collections::BTreeSet::new();
        for metadata in &output.execution_metadata {
            let kcoder_tools::ToolExecutionMetadata::FileRead(evidence) = metadata else {
                continue;
            };
            if !evidence.still_matches() {
                if session
                    .deferred
                    .iter()
                    .any(|record| evidence.path().starts_with(&record.scope_root))
                {
                    self.reject_imported_instruction_read(output, "File content was read, but its stable identity could not be verified for the selected imported instruction scope. Use an unmodified ordinary file in the original target scope before continuing.");
                    return;
                }
                continue;
            }
            match kcoder_config::imported_context::imported_instruction_read_candidates(
                profile,
                session,
                evidence.path(),
            ) {
                Ok(items) => {
                    for record in items {
                        if selected_keys.insert(record.activation_id.as_str()) {
                            selected.push(record);
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(%error,"selected imported instruction scope is no longer available");
                    self.reject_imported_instruction_read(output, "File content was read, but the selected imported instruction scope is unavailable. Restore the original trusted target mapping before continuing this scoped task.");
                    return;
                }
            }
        }
        // Validate every receipt before reserving anything this output may not publish.
        for record in selected {
            let key = &record.activation_id;
            if !self
                .imported_instruction_gate
                .reserve(key, || self.instruction_activation_present(key))
            {
                continue;
            }
            let text =
                kcoder_config::imported_context::imported_instruction_activation_text(record);
            let marker = format!("{MARKER}{key}\">");
            output.user_context.push(ContentBlock::Text {
                text: format!("{marker}\n{text}\n</imported-instruction-activation>"),
            });
        }
    }
    fn reject_imported_instruction_read(&self, output: &mut ToolOutput, text: &str) {
        for metadata in &output.execution_metadata {
            if let kcoder_tools::ToolExecutionMetadata::FileRead(evidence) = metadata
                && let Some((path, offset, limit, full)) = evidence.unpublished_cache_binding()
            {
                self.state
                    .revoke_unpublished_read_result(path, offset, limit, full);
            }
        }
        output.is_error = true;
        output.content = vec![ContentBlock::Text { text: text.into() }];
    }
    /// Called after the complete tool-result batch, preserving pairing and durable rewind/fork semantics.
    pub(super) fn deduplicate_imported_instruction_context(
        &self,
        content: Vec<ContentBlock>,
    ) -> Vec<ContentBlock> {
        content
            .into_iter()
            .filter(|block| {
                let ContentBlock::Text { text } = block else {
                    return true;
                };
                let Some(marker) = text.lines().next().filter(|line| line.starts_with(MARKER))
                else {
                    return true;
                };
                !self.instruction_marker_present(marker)
            })
            .collect()
    }
    fn instruction_activation_present(&self, key: &str) -> bool {
        self.instruction_marker_present(&format!("{MARKER}{key}\">"))
    }
    fn instruction_marker_present(&self, marker: &str) -> bool {
        self.state
            .find_latest_message_map(|message| match message {
                Message::User {
                    content,
                    origin: kcoder_types::MessageOrigin::Runtime,
                    ..
                } => content.iter().find_map(|block| match block {
                    ContentBlock::Text { text } if text.lines().next() == Some(marker) => Some(()),
                    _ => None,
                }),
                _ => None,
            })
            .is_some()
    }
}
