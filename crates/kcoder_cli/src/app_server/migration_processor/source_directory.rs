//! A connection fixes its selected directory before discovery; retries only observe that grant.
use super::*;
use std::path::Path;

pub(super) fn execute(processor: &MigrationProcessor, params: Value) -> Result<Value> {
    let params: MigrationSourceDirectorySelectParams = decode(params)?;
    let mut registry = processor
        .registry
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    ensure!(
        processor
            .uploaded_choice
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?
            .is_none(),
        "migration_selected_root_selection_changed"
    );
    let mut choice = processor
        .directory_choice
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    if let Some(original) = choice.as_ref() {
        ensure!(
            original == &params,
            "migration_selected_root_selection_changed"
        );
    } else {
        ensure!(
            registry.is_none(),
            "migration_selected_root_already_discovered"
        );
        *choice = Some(params.clone());
    }
    // Even an unavailable explicit selection prevents later discovery from choosing home.
    // Retrying the same selection may capture its first grant, but cannot replace a prior one.
    if registry.is_none() {
        *registry = Some(SourceRegistry::from_selected_product_directory(
            Path::new(&params.directory),
            params.source,
        )?);
    }
    let remaining_ms = registry
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_selected_root_unavailable"))?
        .selected_product_directory_remaining_ms()?;
    Ok(serde_json::to_value(MigrationSourceDirectoryResult {
        selection_id: params.selection_id,
        source: params.source,
        remaining_ms,
    })?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selection_retry_keeps_original_root_and_cannot_replace_existing_discovery() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let processor = MigrationProcessor::new();
        let input = json!({"selectionId":"11111111-1111-4111-8111-111111111111","source":"codex","directory":root.path()});
        let first = execute(&processor, input.clone()).unwrap();
        let repeated = execute(&processor, input.clone()).unwrap();
        assert_eq!(first["selectionId"], repeated["selectionId"]);
        assert!(
            repeated["remainingMs"].as_u64().unwrap() <= first["remainingMs"].as_u64().unwrap()
        );
        let mut changed = input.clone();
        changed["directory"] = json!(other.path());
        assert!(
            execute(&processor, changed)
                .unwrap_err()
                .to_string()
                .contains("selection_changed")
        );
        let mut changed = input;
        changed["selectionId"] = json!("22222222-2222-4222-8222-222222222222");
        assert!(execute(&processor, changed).is_err());
        let normal = MigrationProcessor::new();
        *normal.registry.lock().unwrap() = Some(SourceRegistry::new(
            kcoder_migration::discovery::DiscoveryRoots {
                home: root.path().into(),
                claude_config_dir: None,
                codex_home: None,
                project: None,
            },
        ));
        assert!(execute(&normal, json!({"selectionId":"11111111-1111-4111-8111-111111111111","source":"codex","directory":root.path()})).unwrap_err().to_string().contains("already_discovered"));
    }
}
