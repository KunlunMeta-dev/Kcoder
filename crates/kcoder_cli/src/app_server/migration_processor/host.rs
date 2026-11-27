//! Host-owned authority for migration settings and detached history continuation.
use anyhow::Result;
use futures::future::LocalBoxFuture;
use kcoder_migration::{discovery::DiscoveryRoots, history_continuation_jobs::ContinuationRun};
use kcoder_types::historical_continuation::HistoricalContinuationSource;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub trait MigrationHost: Send + Sync {
    fn clone_host(&self) -> Arc<dyn MigrationHost>;
    fn migration_source_roots(&self) -> Result<DiscoveryRoots>;
    fn hook_user_settings_path(&self) -> Result<PathBuf>;
    fn migration_user_settings_path(&self) -> Result<PathBuf>;
    fn migration_mcp_settings_path(&self) -> Result<PathBuf>;
    fn migration_project_settings_path(&self, fields: &[&str]) -> Result<PathBuf>;
    fn migration_project_target_context(&self) -> (PathBuf, Option<PathBuf>);
    fn current_settings(&self) -> Result<kcoder_config::Settings>;
    fn current_skills(&self) -> Result<kcoder_skills::SkillRegistry>;
    fn current_mcp_names(&self) -> Result<Vec<String>>;
    fn continuation_workspace(&self) -> &Path;
    fn continuation_source(&self, thread_id: &str) -> Result<Option<HistoricalContinuationSource>>;
    fn continue_history<'a>(
        &'a self,
        profile: &'a Path,
        run: &'a mut ContinuationRun<'_>,
        token: &'a CancellationToken,
    ) -> LocalBoxFuture<'a, Result<()>>;
}
