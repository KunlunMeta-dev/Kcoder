use super::*;
use kcoder_app_protocol as p;
use std::collections::{HashMap, HashSet};

pub fn valid_comparison_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
pub fn validate_address(device: &str, comparison: &str, owner: &str) -> Result<()> {
    ensure!(
        valid_comparison_text(device, 128),
        "invalid comparison target"
    );
    validate_worktree_id(comparison)?;
    validate_thread_id(owner)
}

pub fn validate_comparison_registry(state: &ClientWorktreeState) -> Result<()> {
    let mut groups: HashMap<&str, Vec<&ClientManagedWorktree>> = HashMap::new();
    for record in state.records.values() {
        let Some(binding) = &record.comparison else {
            continue;
        };
        validate_address(
            &binding.device_id,
            &binding.comparison_id,
            &binding.owner_thread_id,
        )?;
        validate_thread_id(&binding.thread_id)?;
        ensure!(
            valid_comparison_text(&binding.task_id, 512)
                && valid_comparison_text(&binding.label, 128)
                && valid_comparison_text(&binding.requirement, 4096)
                && valid_comparison_text(&binding.branch, 1024),
            "invalid comparison task binding"
        );
        ensure!(
            record.source_path.is_some()
                && record.base_commit.as_ref() == Some(&binding.base_commit),
            "comparison baseline does not match managed worktree"
        );
        if let Some(selection) = &binding.selection {
            ensure!(
                valid_git_object_id(&selection.head_commit)
                    && valid_artifact_id(&selection.content_token),
                "invalid comparison selection"
            );
        }
        groups
            .entry(&binding.comparison_id)
            .or_default()
            .push(record);
    }
    for records in groups.values() {
        ensure!(
            records.len() <= p::MAX_TASK_COMPARISON_CANDIDATES,
            "too many comparison alternatives"
        );
        let first = records[0];
        let base = first.comparison.as_ref().unwrap();
        let mut threads = HashSet::new();
        let mut tasks = HashSet::new();
        let mut branches = HashSet::new();
        let mut selected = 0;
        for record in records {
            let binding = record.comparison.as_ref().unwrap();
            ensure!(
                binding.owner_thread_id == base.owner_thread_id
                    && binding.device_id == base.device_id
                    && binding.requirement == base.requirement
                    && binding.base_commit == base.base_commit
                    && record.source_path == first.source_path,
                "comparison alternatives have incompatible owners or baselines"
            );
            ensure!(
                threads.insert(&binding.thread_id)
                    && tasks.insert(&binding.task_id)
                    && branches.insert(&binding.branch),
                "comparison alternatives are not independent"
            );
            selected += usize::from(binding.selection.is_some());
        }
        ensure!(
            selected <= 1,
            "comparison has multiple selected alternatives"
        );
    }
    Ok(())
}
