//! Correlation consumes only the immutable selected sequence, including cross-archive origins.
use super::*;
use crate::history_codex::selected_record;
use kcoder_types::{historical_branch::HistoricalBranchItems, historical_tool_links::*};

impl HistoryBranchStore {
    pub fn tools_state(&self, root: &str, id: &str) -> Result<HistoricalBranchToolState> {
        self.validate(root, id)?;
        let view = self.archives.branch(id, false)?;
        let running = view.tools_running()?;
        let links = view.tool_links(false)?;
        let run = links
            .as_ref()
            .map(|links| links.run())
            .transpose()?
            .flatten();
        let progress = links.as_ref().map(|links| links.progress()).transpose()?;
        let ready = run
            .as_ref()
            .is_some_and(|run| run.stage == HistoricalToolLinkStage::Ready);
        Ok(HistoricalBranchToolState {
            view_id: id.into(),
            run,
            progress,
            worker_running: !ready && running,
            cancel_requested: !ready && self.archives.branch_tools_control(id)?.cancelled()?,
        })
    }
    pub fn cancel_tools(&self, root: &str, id: &str) -> Result<()> {
        self.validate(root, id)?;
        self.archives.set_branch_tools_cancel(id, true)
    }
    pub fn tools_page(
        &self,
        root: &str,
        id: &str,
        cursor: Option<&str>,
    ) -> Result<HistoricalToolLinkPage> {
        self.validate(root, id)?;
        let view = self.archives.branch(id, false)?;
        let links = view
            .tool_links(false)?
            .context("history_tool_links_not_ready")?;
        ensure!(
            links
                .run()?
                .is_some_and(|run| run.stage == HistoricalToolLinkStage::Ready),
            "history_tool_links_not_ready"
        );
        links.page(cursor, 10)
    }
    pub fn correlate(
        &self,
        root: &str,
        id: &str,
        resume: Option<u64>,
        mut check: impl FnMut() -> bool,
    ) -> Result<HistoricalBranchToolState> {
        let recipe = self.validate(root, id)?;
        let view = self.archives.branch(id, false)?;
        let total = view.progress()?.written_items;
        let mut links = view
            .tool_links(true)?
            .context("history_tool_links_not_ready")?;
        drop(view);
        let run = links.begin_run(resume)?;
        if run.stage == HistoricalToolLinkStage::Ready {
            drop(links);
            return self.tools_state(root, id);
        }
        if resume.is_some() {
            self.archives.set_branch_tools_cancel(id, false)?;
        }
        let control = self.archives.branch_tools_control(id)?;
        let mut cancelled = false;
        let result = (|| -> Result<()> {
            let mut cursor = 0;
            while cursor < total {
                if !check() || control.cancelled()? {
                    cancelled = true;
                    anyhow::bail!("history_tool_links_cancelled");
                }
                let snapshot: HistoricalBranchItems =
                    self.archives.branch(id, false)?.page(cursor)?;
                ensure!(snapshot.recipe == recipe, "history_branch_source_changed");
                for (at, reference) in snapshot.items.iter().enumerate() {
                    if !check() || control.cancelled()? {
                        cancelled = true;
                        anyhow::bail!("history_tool_links_cancelled");
                    }
                    let source = recipe
                        .sources
                        .get(reference.source_index as usize)
                        .context("history_branch_invalid_source")?;
                    let archive = self.archives.reader(&source.archive_id)?;
                    let index = archive
                        .projection(&recipe.normalization_revision, false)?
                        .context("history_branch_source_changed")?;
                    ensure!(
                        index.source_fingerprint() == source.projection_fingerprint,
                        "history_branch_source_changed"
                    );
                    let record = selected_record(index.record(reference.record)?, reference)?;
                    drop(index);
                    let origin = HistoricalToolOrigin {
                        source_index: reference.source_index,
                        replacement_index: reference.replacement_index,
                        omitted_blocks: reference.omitted_blocks.clone(),
                    };
                    links.append_resolved(cursor + at as u64, &record, &origin)?;
                }
                let end = cursor + snapshot.items.len() as u64;
                ensure!(end > cursor, "history_tool_links_cursor_gap");
                cursor = end;
            }
            if !check() || control.cancelled()? {
                cancelled = true;
                anyhow::bail!("history_tool_links_cancelled");
            }
            links.finish_run(total)?;
            Ok(())
        })();
        if let Err(error) = result {
            links.stop_run(cancelled, Some(&error.to_string()))?;
        }
        drop(links);
        self.tools_state(root, id)
    }
}
