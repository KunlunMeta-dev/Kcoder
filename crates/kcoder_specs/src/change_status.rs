//! Spec change status domain implementation.

use super::*;

/// Return the status summary for a single change.
pub fn status(cwd: &Path, name: &str) -> Result<ChangeStatusSummary> {
    let change_dir = checked_change_dir(cwd, name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let specs_dir = specs_dir_for(cwd);
    let schema = metadata_schema_or_default(&meta);

    let artifacts = required_artifacts_for_schema(&schema)
        .iter()
        .map(|artifact| {
            let path = change_dir.join(*artifact);
            let present = path.exists();
            let non_empty = present
                && if path.is_dir() {
                    fs::read_dir(&path)
                        .ok()
                        .map(|mut d| d.next().is_some())
                        .unwrap_or(false)
                } else {
                    fs::metadata(&path)
                        .ok()
                        .map(|m| m.len() > 0)
                        .unwrap_or(false)
                };
            ArtifactStatus {
                name: (*artifact).to_string(),
                present,
                non_empty,
            }
        })
        .collect();

    let tasks_path = change_dir.join("tasks.md");
    let tasks_complete = if tasks_path.exists() {
        match fs::read_to_string(&tasks_path) {
            Ok(text) => !text.contains("[ ]") && text.contains("[x]"),
            Err(_) => false,
        }
    } else {
        false
    };

    let drift_errors = fingerprint::check_change(&specs_dir, &change_dir).unwrap_or_default();
    let apply_blockers = apply_blockers_for_schema(&schema, &change_dir);
    let verification = verification_status(&change_dir);
    let completion_blockers = completion_blockers_for_schema(&schema, &change_dir, &verification);

    Ok(ChangeStatusSummary {
        name: meta.name,
        title: meta.title,
        schema,
        status: meta.status,
        artifacts,
        tasks_complete,
        drift_errors,
        apply_blockers,
        completion_blockers,
        verification,
    })
}
