use anyhow::{Result, ensure};
use kcoder_types::workflow::*;

pub(super) fn relative_path(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && path.len() <= 1024
            && !path.starts_with('/')
            && !path.contains(['\\', ':', '*', '?', '[', ']', '{', '}', '\0'])
            && !path.chars().any(char::is_control),
        "workflow_collaboration: paths must be concrete portable workspace-relative paths"
    );
    ensure!(
        path.split('/').all(|part| !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])),
        "workflow_collaboration: ambiguous or escaping path component"
    );
    Ok(())
}
pub(super) fn model(value: &WorkflowAgentModelSelection) -> Result<()> {
    if let WorkflowAgentModelSelection::Explicit {
        profile,
        provider,
        model,
        expected_revision,
    } = value
    {
        ensure!(
            profile.is_some() != provider.is_some(),
            "workflow_model: select exactly one configured profile or provider"
        );
        ensure!(
            !profile
                .iter()
                .chain(provider)
                .any(|value| value.eq_ignore_ascii_case("current")),
            "workflow_model: use inherit_current mode for the current model"
        );
        for id in profile
            .iter()
            .chain(provider)
            .chain(std::iter::once(model))
            .chain(expected_revision)
        {
            ensure!(
                !id.trim().is_empty() && id.len() <= 256 && !id.chars().any(char::is_control),
                "workflow_model: bounded nonempty model identities required"
            );
        }
    }
    Ok(())
}
pub(super) fn artifacts(values: &[WorkflowArtifactRequirement]) -> Result<()> {
    ensure!(
        values.len() <= 32,
        "workflow_artifact: at most 32 declarations"
    );
    let mut paths = std::collections::BTreeSet::new();
    for item in values {
        relative_path(&item.path)?;
        ensure!(
            paths.insert(&item.path),
            "workflow_artifact: duplicate path declaration"
        );
        ensure!(
            item.min_bytes <= 16 * 1024 * 1024
                && item.forbidden_literals.len() <= 16
                && item
                    .forbidden_literals
                    .iter()
                    .all(|value| !value.is_empty() && value.len() <= 256)
                && item
                    .forbidden_literals
                    .iter()
                    .map(String::len)
                    .sum::<usize>()
                    <= 4096,
            "workflow_artifact: invalid declaration bounds"
        );
    }
    Ok(())
}
pub(super) fn inside(path: &str, scopes: &[String]) -> bool {
    scopes.iter().any(|scope| {
        path == scope
            || path
                .strip_prefix(scope)
                .is_some_and(|tail| tail.starts_with('/'))
    })
}
