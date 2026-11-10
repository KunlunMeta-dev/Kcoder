//! Read/prepare authority is the resumed owner thread; selected sources grant observation only.
use super::*;
use kcoder_app_protocol::{self as p, task_delivery::method as dm};

#[cfg(test)]
mod tests;

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        dm::PREPARE
            | dm::READ
            | dm::REQUEST
            | dm::FAILURE
            | p::TASK_COMPARISON_BIND
            | p::TASK_COMPARISON_READ
            | p::TASK_COMPARISON_SELECT
    )
}

fn owner_engine(manager: &ThreadManager, thread: &str) -> Result<QueryEngine> {
    validate_thread_id(thread)?;
    let engine = manager
        .engine(thread)
        .context("review_owner_unavailable: resume the original owner thread on this connection")?;
    ensure_active_thread(&engine, manager.lease(thread), thread)?;
    ensure!(
        engine.state.artifact_session_id() == thread,
        "review owner artifact identity mismatch"
    );
    Ok(engine)
}
fn validate_owner(thread: &str, owner: &p::TaskDeliveryRecipient) -> Result<()> {
    ensure!(
        owner.thread_id == thread
            && !owner.task_id.is_empty()
            && owner.task_id.len() <= 512
            && !owner.device_id.is_empty()
            && owner.device_id.len() <= 128
            && !owner.task_id.chars().any(char::is_control)
            && !owner.device_id.chars().any(char::is_control),
        "delivery owner routing labels do not match the original thread"
    );
    Ok(())
}

enum Input {
    Prepare(p::TaskDeliveryPrepareParams),
    Read(p::TaskDeliveryReadParams),
    Request(p::TaskDeliveryRequestParams),
    Failure(p::TaskDeliveryFailureParams),
}
impl Input {
    fn parse(method: &str, params: Value) -> Result<Self> {
        Ok(match method {
            dm::PREPARE => Self::Prepare(serde_json::from_value(params)?),
            dm::READ => Self::Read(serde_json::from_value(params)?),
            dm::REQUEST => Self::Request(serde_json::from_value(params)?),
            dm::FAILURE => Self::Failure(serde_json::from_value(params)?),
            _ => anyhow::bail!("unsupported delivery method"),
        })
    }
    fn owner(&self) -> (&str, &p::TaskDeliveryRecipient) {
        match self {
            Self::Prepare(p) => (&p.thread_id, &p.owner),
            Self::Read(p) => (&p.thread_id, &p.owner),
            Self::Request(p) => (&p.thread_id, &p.owner),
            Self::Failure(p) => (&p.thread_id, &p.owner),
        }
    }
    fn delivery_id(&self) -> Option<&str> {
        match self {
            Self::Prepare(_) => None,
            Self::Read(p) => Some(&p.delivery_id),
            Self::Request(p) => Some(&p.delivery_id),
            Self::Failure(p) => Some(&p.delivery_id),
        }
    }
}

pub(super) async fn request(method: &str, params: Value, manager: &ThreadManager) -> Result<Value> {
    if matches!(
        method,
        p::TASK_COMPARISON_BIND | p::TASK_COMPARISON_READ | p::TASK_COMPARISON_SELECT
    ) {
        // Bind/Select threadId identifies candidate B. Only ownerThreadId selects the owning runtime A.
        let owner_thread = match method {
            p::TASK_COMPARISON_BIND => {
                kcoder_app_rpc_codec::decode::<p::TaskComparisonBindParams>(params.clone())?
                    .owner_thread_id
            }
            p::TASK_COMPARISON_READ => {
                kcoder_app_rpc_codec::decode::<p::TaskComparisonReadParams>(params.clone())?
                    .owner_thread_id
            }
            p::TASK_COMPARISON_SELECT => {
                kcoder_app_rpc_codec::decode::<p::TaskComparisonSelectParams>(params.clone())?
                    .owner_thread_id
            }
            _ => unreachable!(),
        };
        let owner = owner_engine(manager, &owner_thread)?;
        return task_comparison::task_comparison_request(&owner, method, &params).await;
    }
    let input = Input::parse(method, params)?;
    let (owner_thread, address) = input.owner();
    validate_owner(owner_thread, address)?;
    let owner = owner_engine(manager, owner_thread)?;
    ensure!(
        owner.durable_client_storage_root().is_some(),
        "delivery_durable_storage_unavailable: temporary session storage cannot retain publication identities"
    );
    let session = owner.session_storage_dir_for(owner_thread);
    let retained = input
        .delivery_id()
        .map(|id| task_delivery::binding(&session, owner_thread, id))
        .transpose()?;
    let comparison = match &input {
        Input::Prepare(params) => params.comparison_id.clone(),
        _ => retained
            .as_ref()
            .and_then(|(_, comparison)| comparison.clone()),
    };
    let selected = match comparison.as_deref() {
        Some(id) => Some(
            task_comparison::selected_comparison_source(
                &owner,
                id,
                owner_thread,
                &address.device_id,
            )
            .await?
            .context("delivery source has no selected comparison alternative")?,
        ),
        None => None,
    };
    let workspace = selected
        .as_ref()
        .map(|s| s.workspace_root.clone())
        .unwrap_or_else(|| owner.state.cwd());
    let recipient = selected
        .as_ref()
        .map(|s| p::TaskDeliveryRecipient {
            task_id: s.task_id.clone(),
            thread_id: s.thread_id.clone(),
            device_id: s.device_id.clone(),
        })
        .unwrap_or_else(|| address.clone());
    if let Some((retained_recipient, _)) = &retained {
        ensure!(
            *retained_recipient == recipient,
            "delivery source recipient changed; inspect the original binding"
        );
    }
    // The shared managed-worktree lease prevents archive/delete while only this observation runs.
    let source_lease = selected
        .as_ref()
        .map(|source| {
            client_worktree_store(&owner).open_workspace_runtime_lease(&source.workspace_root)
        })
        .transpose()?;
    if let Some(lease) = &source_lease {
        fs2::FileExt::try_lock_shared(lease).context("selected source is being archived")?;
    }
    let value = match &input {
        Input::Prepare(params) => {
            let evidence = source_evidence(&owner, selected.as_ref(), &recipient)?;
            serde_json::to_value(
                task_delivery::prepare(&workspace, &session, params, &evidence, &recipient).await?,
            )?
        }
        Input::Read(params) => serde_json::to_value(
            task_delivery::read(&workspace, &session, params, &recipient).await?,
        )?,
        Input::Request(params) => serde_json::to_value(
            task_delivery::request(&workspace, &session, params, &recipient).await?,
        )?,
        Input::Failure(params) => serde_json::to_value(
            task_delivery::failure(&workspace, &session, params, &recipient).await?,
        )?,
    };
    if let Some(original) = selected {
        let current = task_comparison::selected_comparison_source(
            &owner,
            &original.comparison_id,
            owner_thread,
            &address.device_id,
        )
        .await?
        .context("selected delivery source disappeared")?;
        ensure!(
            current.task_id == original.task_id
                && current.thread_id == original.thread_id
                && current.device_id == original.device_id
                && current.worktree_id == original.worktree_id
                && current.workspace_root == original.workspace_root
                && current.branch == original.branch
                && current.head_commit == original.head_commit
                && current.base_commit == original.base_commit
                && current.history_path == original.history_path
                && current.artifact_root == original.artifact_root,
            "selected delivery source changed during observation"
        );
    }
    Ok(value)
}

fn source_evidence(
    owner: &QueryEngine,
    selected: Option<&task_comparison::SelectedComparisonSource>,
    recipient: &p::TaskDeliveryRecipient,
) -> Result<Vec<p::TurnReviewEvidence>> {
    // Selected source storage is resolved from its already authorized workspace, never a caller path.
    let mut records = match selected {
        Some(source) => task_comparison::selected_source_review_evidence(owner, source)?,
        None => turn_review_evidence::load_turn_review_evidence(owner, &recipient.thread_id)?,
    }
    .into_values()
    .collect::<Vec<_>>();
    records.sort_by_key(|r| {
        std::cmp::Reverse(
            r.observations
                .iter()
                .filter_map(|o| o.result_observed_at_ms)
                .max()
                .unwrap_or(0),
        )
    });
    records.truncate(8);
    Ok(records)
}
