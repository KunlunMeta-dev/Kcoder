//! Source capability advertisements do not describe the destination's available tools.
use super::*;
use crate::history_json::{self, Segment, Value};

pub(super) fn is_foreign_capability_catalog(
    archive: &ExternalHistoryReader,
    record: &HistoricalRecord,
    check: impl FnMut(u64) -> bool,
) -> Result<bool> {
    if record.source != kcoder_types::migration::MigrationSourceKind::ClaudeCode
        || !matches!(&record.data, HistoricalRecordData::Metadata {source_type,..} if source_type=="attachment")
    {
        return Ok(false);
    }
    let mut attachment = false;
    let mut catalog = false;
    history_json::walk(
        archive.open_record(record.record)?,
        |path, node| {
            let Value::String(value) = node.value else {
                return Ok(());
            };
            match path {
                [Segment::Key(key)] if key == "type" => {
                    attachment = value.preview == "attachment" && value.bytes == 10;
                }
                [Segment::Key(parent), Segment::Key(key)]
                    if parent == "attachment" && key == "type" =>
                {
                    catalog = matches!(
                        value.preview.as_str(),
                        "agent_listing_delta" | "skill_listing"
                    ) && value.bytes == value.preview.len() as u64;
                }
                _ => {}
            }
            Ok(())
        },
        check,
    )?;
    Ok(attachment && catalog)
}
