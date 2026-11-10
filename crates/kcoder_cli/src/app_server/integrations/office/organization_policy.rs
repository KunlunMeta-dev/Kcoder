//! Current Native Office namespace policy, separate from source and task authority.
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner};
use sha2::{Digest, Sha256};

pub(super) fn resource_id(owner: &IntegrationOwner) -> Result<String> {
    ensure!(
        matches!(owner.workspace_id, IntegrationNullable::Value(_))
            && matches!(owner.organization_id, Some(IntegrationNullable::Value(_))),
        "OFFICE_ORGANIZATION_SCOPE_REQUIRED"
    );
    let data = serde_json::to_vec(&serde_json::json!([
        "native-office-resource-v1",
        "current-target",
        owner.account_id,
        owner.target_id,
        owner.workspace_id,
        owner.organization_id
    ]))?;
    Ok(format!("office:{:x}", Sha256::digest(data)))
}

pub(super) fn verify(native: &NativeIntegrationContext) -> Result<Option<u64>> {
    native.verify()?;
    if native.scope().organization_id.is_none() {
        return Ok(None);
    }
    resource_id(&IntegrationOwner::from(native.scope()))?;
    Ok(Some(
        native
            .organization_policy_revision()?
            .context("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")?,
    ))
}

pub(super) fn authorize(
    native: &NativeIntegrationContext,
    action: &str,
    request_id: &str,
) -> Result<Option<u64>> {
    authorize_actions(native, &[action], request_id)
}

pub(super) fn authorize_actions(
    native: &NativeIntegrationContext,
    actions: &[&str],
    request_id: &str,
) -> Result<Option<u64>> {
    ensure!(
        !actions.is_empty()
            && actions
                .iter()
                .all(|action| matches!(*action, "read" | "use" | "write" | "execute" | "export")),
        "OFFICE_POLICY_DENIED"
    );
    let Some(revision) = verify(native)? else {
        return Ok(None);
    };
    let resource = resource_id(&IntegrationOwner::from(native.scope()))?;
    for action in actions {
        native
            .authorize_organization_resource(action, &resource, request_id)
            .map_err(|_| anyhow::anyhow!("OFFICE_POLICY_DENIED"))?;
    }
    ensure!(
        native.organization_policy_revision()? == Some(revision),
        "OFFICE_SCOPE_CHANGED"
    );
    native.verify()?;
    Ok(Some(revision))
}

pub(in crate::app_server) fn authorize_office_action(
    native: &NativeIntegrationContext,
    action: &str,
    request_id: &str,
) -> Result<Option<u64>> {
    authorize_actions(
        native,
        required_actions(action).context("OFFICE_POLICY_DENIED")?,
        request_id,
    )
}

pub(super) fn required_actions(action: &str) -> Option<&'static [&'static str]> {
    match action {
        "office.assistant.read"
        | "office.artifact.read"
        | "office.artifact.source.read"
        | "office.dataset.read"
        | "office.input.read"
        | "office.operation.read"
        | "office.generator.inspect" => Some(&["read"]),
        "office.assistant.write" | "office.assistant.adopt" | "office.assistant.import" => {
            Some(&["write"])
        }
        "office.artifact.publish" | "office.dataset.write" => Some(&["read", "use", "write"]),
        "office.assistant.export" | "office.artifact.export" => Some(&["read", "export"]),
        "office.assistant.execute" | "office.document.generate" | "office.artifact.verify" => {
            Some(&["read", "use", "write", "execute"])
        }
        _ => None,
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "organization_policy/native_tests.rs"]
mod native_tests;
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn office_resource_is_bound_to_every_actual_owner_dimension() {
        let owner: IntegrationOwner = serde_json::from_value(json!({"accountId":"account-one",
            "targetId":"target-one","workspaceId":"workspace-one","organizationId":"org-one"}))
        .unwrap();
        let first = resource_id(&owner).unwrap();
        for key in ["accountId", "targetId", "workspaceId", "organizationId"] {
            let mut value = serde_json::to_value(&owner).unwrap();
            value[key] = json!("different-owner");
            assert_ne!(
                first,
                resource_id(&serde_json::from_value(value).unwrap()).unwrap()
            );
        }
        let mut missing = owner;
        missing.workspace_id = IntegrationNullable::Null;
        assert!(resource_id(&missing).is_err());
    }
    #[test]
    fn operation_labels_never_become_arbitrary_policy_actions() {
        assert_eq!(
            required_actions("office.assistant.execute"),
            Some(&["read", "use", "write", "execute"][..])
        );
        assert_eq!(
            required_actions("office.document.generate"),
            Some(&["read", "use", "write", "execute"][..])
        );
        assert_eq!(
            required_actions("office.artifact.export"),
            Some(&["read", "export"][..])
        );
        assert!(required_actions("office.organization.publish").is_none());
        assert!(required_actions("approved").is_none());
    }
}
