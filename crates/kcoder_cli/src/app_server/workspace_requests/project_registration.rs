//! An opt-in addition policy, checked under the existing registry writer lock.
use anyhow::{Result, ensure};
use kcoder_workspace_resources::managed_worktrees::{ClientWorkspaceState, ClientWorkspaceStore};
use serde_json::Value;

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RegistrationPolicy {
    #[serde(default)]
    preserve_existing: bool,
}

fn keeps_observed_fields(original: &Value, projected: &Value) -> bool {
    match (original, projected) {
        (Value::Object(left), Value::Object(right)) => left.iter().all(|(key, value)| {
            right
                .get(key)
                .is_some_and(|other| keeps_observed_fields(value, other))
        }),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(a, b)| keeps_observed_fields(a, b))
        }
        _ => original == projected,
    }
}

/// Called while holding the original writer lock; legacy edits keep their original loader.
pub(super) fn load_for_addition(
    params: &Value,
    store: &ClientWorkspaceStore,
) -> Result<ClientWorkspaceState> {
    let policy: RegistrationPolicy = serde_json::from_value(params.clone())
        .map_err(|_| anyhow::anyhow!("workspace_project_registration_invalid"))?;
    if !policy.preserve_existing {
        return Ok(store.load());
    }
    let failure = || anyhow::anyhow!("workspace_project_registration_unavailable");
    let parent = store.storage_path().parent().ok_or_else(failure)?;
    let directory =
        kcoder_config::PrivateDirectory::open_existing(parent).map_err(|_| failure())?;
    let name = std::ffi::OsStr::new("client-workspaces.json");
    let before = match directory.open_single_link_regular_file(name) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(ClientWorkspaceState {
                version: 1,
                ..Default::default()
            });
        }
        Err(_) => return Err(failure()),
    };
    let identity = kcoder_config::PortableLeaseIdentity::from_regular_handle(&before)
        .map_err(|_| failure())?;
    let document = directory
        .read_source_document_snapshot(name, 4 * 1024 * 1024, || true)
        .map_err(|_| failure())?;
    let after = directory
        .open_single_link_regular_file(name)
        .map_err(|_| failure())?;
    ensure!(
        identity
            == kcoder_config::PortableLeaseIdentity::from_regular_handle(&after)
                .map_err(|_| failure())?,
        "workspace_project_registration_unavailable"
    );
    let original: Value = serde_json::from_slice(document.bytes()).map_err(|_| failure())?;
    let state: ClientWorkspaceState =
        serde_json::from_value(original.clone()).map_err(|_| failure())?;
    ensure!(
        state.version == 1 && keeps_observed_fields(&original, &serde_json::to_value(&state)?),
        "workspace_project_registration_unavailable"
    );
    Ok(state)
}

pub(super) fn verify_addition(
    params: &Value,
    roots: &[String],
    project_key: &str,
    state: &ClientWorkspaceState,
) -> Result<()> {
    let policy: RegistrationPolicy = serde_json::from_value(params.clone())
        .map_err(|_| anyhow::anyhow!("workspace_project_registration_invalid"))?;
    if policy.preserve_existing {
        ensure!(
            roots.iter().all(|path| !state.records.contains_key(path))
                && !state
                    .records
                    .values()
                    .any(|record| record.project_key == project_key)
                && !state.project_order.iter().any(|key| key == project_key),
            "workspace_project_already_registered"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_workspace_resources::managed_worktrees::ClientWorkspaceRecord;
    use serde_json::json;
    #[test]
    fn existing_paths_keys_and_user_metadata_are_never_reassigned_by_an_opted_in_registration() {
        let mut state = ClientWorkspaceState {
            project_order: vec!["user-key".into()],
            ..Default::default()
        };
        state.records.insert(
            "/canonical/owned".into(),
            ClientWorkspaceRecord {
                workspace_path: "/canonical/owned".into(),
                label: "User label".into(),
                project_key: "user-key".into(),
                roots: vec!["/canonical/owned".into(), "/canonical/second".into()],
                pinned: true,
                appearance: json!({"user":"keep"}),
                ..Default::default()
            },
        );
        let original = serde_json::to_vec(&state).unwrap();
        let params = json!({"preserveExisting":true});
        assert!(verify_addition(&params, &["/canonical/owned".into()], "new-key", &state).is_err());
        assert!(verify_addition(&params, &["/canonical/new".into()], "user-key", &state).is_err());
        assert!(verify_addition(&params, &["/canonical/new".into()], "new-key", &state).is_ok());
        assert_eq!(original, serde_json::to_vec(&state).unwrap());
        assert!(
            verify_addition(&json!({}), &["/canonical/owned".into()], "user-key", &state).is_ok()
        );
        for value in [json!(null), json!("true"), json!(1)] {
            assert!(
                verify_addition(&json!({"preserveExisting":value}), &[], "key", &state).is_err()
            );
        }
    }
}
