use super::*;
use crate::{
    history_discovery::{HistoryCatalog, HistorySelectionGrant},
    history_sources::HistorySourceBinding,
};
use kcoder_types::external_history::HistorySourcePage;

impl SourceRegistry {
    pub fn discover_history(
        &mut self,
        kind: MigrationSourceKind,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistorySourcePage> {
        self.discover_history_mode(kind, false, check)
    }

    pub fn discover_history_families(
        &mut self,
        kind: MigrationSourceKind,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistorySourcePage> {
        ensure!(
            kind == MigrationSourceKind::Codex,
            "history_discovery_family_source_unsupported"
        );
        self.discover_history_mode(kind, true, check)
    }

    fn discover_history_mode(
        &mut self,
        kind: MigrationSourceKind,
        families: bool,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<HistorySourcePage> {
        self.verify_selected_root(Some(kind))?;
        self.history_catalogs
            .retain(|_, catalog| !catalog.expired());
        ensure!(
            self.history_catalogs.len() < 16,
            "history_discovery_catalog_limit"
        );
        let custom = match kind {
            MigrationSourceKind::ClaudeCode => &self.roots.claude_config_dir,
            MigrationSourceKind::Codex => &self.roots.codex_home,
        };
        let root = custom.clone().unwrap_or_else(|| {
            self.roots.home.join(match kind {
                MigrationSourceKind::ClaudeCode => ".claude",
                MigrationSourceKind::Codex => ".codex",
            })
        });
        ensure!(root.is_absolute(), "history_discovery_unsafe_root");
        let catalog = if families {
            HistoryCatalog::discover_codex_families(&root, &mut check)?
        } else {
            HistoryCatalog::discover(&root, kind, &mut check)?
        };
        let retained = self
            .history_catalogs
            .values()
            .map(HistoryCatalog::estimated_bytes)
            .sum::<usize>();
        ensure!(
            retained + catalog.estimated_bytes() <= 64 * 1024 * 1024,
            "history_discovery_catalog_budget_exceeded"
        );
        let page = self.uploaded_history_page(catalog.page(None, check)?);
        self.history_catalogs.insert(catalog.id().into(), catalog);
        Ok(page)
    }

    pub fn history_page(
        &self,
        catalog_id: &str,
        cursor: Option<&str>,
        check: impl FnMut(u64) -> bool,
    ) -> Result<HistorySourcePage> {
        self.verify_selected_root(None)?;
        let page = self
            .history_catalogs
            .get(catalog_id)
            .ok_or_else(|| anyhow::anyhow!("history_discovery_catalog_unavailable"))?
            .page(cursor, check)?;
        Ok(self.uploaded_history_page(page))
    }

    fn uploaded_history_page(&self, mut page: HistorySourcePage) -> HistorySourcePage {
        if self
            .selected_root
            .as_ref()
            .is_some_and(|selected| selected.binding.uploaded().is_some())
        {
            for item in &mut page.items {
                // The materialized mtime is not a timestamp from the supplied source.
                item.modified_at_ms = None;
            }
        }
        page
    }

    pub fn selected_history(
        &self,
        catalog_id: &str,
        source_handle: &str,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        self.history_selection(catalog_id, source_handle)?
            .capture(check)
    }

    /// Resolve under the registry lock; perform large snapshot IO on the returned native grant.
    pub fn history_selection(
        &self,
        catalog_id: &str,
        source_handle: &str,
    ) -> Result<HistorySelectionGrant> {
        self.verify_selected_root(None)?;
        self.history_catalogs
            .get(catalog_id)
            .ok_or_else(|| anyhow::anyhow!("history_discovery_catalog_unavailable"))?
            .selection(source_handle)?
            .with_uploaded_root(
                self.selected_root
                    .as_ref()
                    .and_then(|root| root.binding.uploaded()),
            )
    }
}
