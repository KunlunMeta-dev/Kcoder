//! The existing MCP store/group owns publication; this only replaces the private input reader.
use super::*;
use crate::source_transfer::private_credentials::{
    CredentialSourceBinding, ReceivedCredentialInput,
};

pub(super) fn prepare_material(
    store: &ImportedCredentialStore,
    profile_identity: &str,
    item: &NormalizedItem,
    input: ReceivedCredentialInput<'_>,
    saved: &McpServerConfig,
    fields: &[Field],
    consent: bool,
) -> Result<McpCredentialPlan> {
    let ReceivedCredentialInput {
        source,
        material: received,
        execution,
        policy,
        backend,
    } = input;
    ensure!(consent, "migration_mcp_private_consent_required");
    ensure!(
        policy == received.policy(),
        "private_credentials_policy_changed"
    );
    received.validate_source(source, item)?;
    let fields = canonical_private_fields(fields)?;
    let mut original = source
        .inventory()?
        .items
        .into_iter()
        .find(|v| v.mcp.is_some() && v.preview.source_name == item.preview.source_name)
        .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?;
    original.preview.id = item.preview.id.clone();
    let resolved = crate::mcp::resolve(
        &original,
        &crate::mcp::McpResolution {
            item_id: item.preview.id.clone(),
            target_name: saved.name.clone(),
            cwd: saved.policy.cwd.clone(),
            enable_after_import: false,
        },
    )?;
    let mut public = saved.clone();
    public.policy.credential_ref = None;
    ensure!(
        resolved.mcp.as_ref().unwrap().config == public,
        "migration_mcp_private_destination_changed"
    );
    let secret = received.mcp_values(
        profile_identity,
        backend,
        &item.preview.source_name,
        &saved.name,
        &fields,
        execution,
    )?;
    let preserved = extension::prepare(store, saved, &fields, policy, backend)?;
    let mut all = fields.clone();
    if let Some(previous) = &preserved {
        all.extend(previous.fields.iter().cloned());
    }
    let env = all
        .iter()
        .filter_map(|v| {
            if let Field::Environment(name) = v {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let headers = all
        .iter()
        .filter_map(|v| {
            if let Field::Header(name) = v {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let reference = if preserved.is_some() {
        store.prepare_mcp_extension(saved, &env, &headers, policy, backend)
    } else {
        store.prepare_mcp(saved, &env, &headers, policy, backend)
    }
    .map_err(safe_error)?;
    let mut config = saved.clone();
    config.policy.credential_ref = Some(reference.mcp_reference().map_err(safe_error)?);
    Ok(McpCredentialPlan {
        plan_id: reference.operation_id.clone(),
        group_id: format!("group-{}", uuid::Uuid::new_v4().simple()),
        item_id: item.preview.id.clone(),
        source_name: item.preview.source_name.clone(),
        fields,
        source: CredentialSourceBinding::Received(Box::new(received.clone())),
        reference,
        original: saved.clone(),
        config,
        policy,
        phase: CredentialPhase::Ready,
        undo_requested: false,
        error_code: None,
        expected_revision: None,
        published_revision: None,
        atomic_group_id: None,
        fingerprint: hash(&secret),
        preserved,
    })
}
