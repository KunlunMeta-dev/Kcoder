//! Existing private values remain native-owned; only field names and a fingerprint enter plans.
use super::*;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PreservedFields {
    pub fields: Vec<Field>,
    fingerprint: String,
}

pub(super) fn prepare(
    store: &ImportedCredentialStore,
    config: &McpServerConfig,
    selected: &[Field],
    policy: CredentialStoreMode,
    backend: &dyn CredentialBackend,
) -> Result<Option<PreservedFields>> {
    if config.policy.credential_ref.is_none() {
        return Ok(None);
    }
    let previous = store
        .resolve_mcp_with_mode(config, policy, backend)
        .map_err(safe_error)?;
    let fields = previous
        .env
        .keys()
        .cloned()
        .map(Field::Environment)
        .chain(
            previous
                .headers
                .keys()
                .map(|name| Field::Header(name.to_ascii_lowercase())),
        )
        .collect::<Vec<_>>();
    ensure!(
        selected.iter().all(|field| !fields.contains(field)),
        "migration_mcp_private_field_already_bound"
    );
    Ok(Some(PreservedFields {
        fields,
        fingerprint: hash(&previous.encode().map_err(safe_error)?),
    }))
}

pub(super) fn merge(
    plan: &McpCredentialPlan,
    store: &ImportedCredentialStore,
    backend: &dyn CredentialBackend,
    selected: &str,
) -> Result<Zeroizing<String>> {
    let Some(preserved) = &plan.preserved else {
        return Ok(Zeroizing::new(selected.to_owned()));
    };
    let mut previous = store
        .resolve_mcp_with_mode(&plan.original, plan.policy, backend)
        .map_err(safe_error)?;
    ensure!(
        hash(&previous.encode().map_err(safe_error)?) == preserved.fingerprint,
        "migration_mcp_private_destination_changed"
    );
    let next: McpSecretValues = serde_json::from_str(selected)
        .map_err(|_| anyhow::anyhow!("migration_mcp_private_invalid_payload"))?;
    for (name, value) in &next.env {
        ensure!(
            !previous.env.contains_key(name),
            "migration_mcp_private_field_already_bound"
        );
        previous.env.insert(name.clone(), value.clone());
    }
    for (name, value) in &next.headers {
        ensure!(
            !previous
                .headers
                .keys()
                .any(|old| old.eq_ignore_ascii_case(name)),
            "migration_mcp_private_field_already_bound"
        );
        previous.headers.insert(name.clone(), value.clone());
    }
    previous.encode().map_err(safe_error)
}

impl McpCredentialPlan {
    pub(super) fn covers(&self, field: &Field) -> bool {
        self.fields.contains(field)
            || self
                .preserved
                .as_ref()
                .is_some_and(|previous| previous.fields.contains(field))
    }
}
