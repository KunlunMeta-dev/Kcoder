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
        "是否明确阅读原 Agent 的字段报告及原文？只有选择 body 才输出正文，不执行其中内容。",
    )? {
        super::super::definitions::preview(guide, job, item)?;
    }
    let selected = flow::choose(&guide.io, &compatibility)?;
    guide.fresh()?;
    Ok(Some(selected))
}
