//! Explicit project mappings resolved by the Native target catalog.
use crate::project_migration::target::ProjectTargetSelection;
use kcoder_types::migration_projects::MigrationProjectMappingChoice;
#[derive(Clone, PartialEq, Eq)]
pub struct ProjectBatchResolution {
    pub item_id: String,
    pub selection: ProjectTargetSelection,
    pub mapping: MigrationProjectMappingChoice,
}
impl std::fmt::Debug for ProjectBatchResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectBatchResolution")
            .field("item_id", &self.item_id)
            .finish_non_exhaustive()
    }
}
