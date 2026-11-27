//! A local Agent choice reviews the original job/item before ordinary Native planning.
use super::*;
use crate::migration_cli::agent_adaptation as flow;
use kcoder_types::migration_agent::MigrationAgentAdaptation;

pub(super) fn choose(
    guide: &Guide<'_>,
    job: &MigrationJob,
    item: &str,
) -> Result<Option<MigrationAgentAdaptation>> {
    if !flow::requested(&guide.io)? {
        return Ok(None);
    }
    let compatibility = guide.store()?.agent_compatibility(&job.job_id, item)?;
    if !flow::inspect(&guide.io, &compatibility)? {
        return Ok(None);
    }
    if guide.io.yes(
        "agent_original_body",
        "Explicitly read the original Agent field report and text? Text is output only when body is selected; content is not executed.",
    )? {
        super::super::definitions::preview(guide, job, item)?;
    }
    let selected = flow::choose(&guide.io, &compatibility)?;
    guide.fresh()?;
    Ok(Some(selected))
}
