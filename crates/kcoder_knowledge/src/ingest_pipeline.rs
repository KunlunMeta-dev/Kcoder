//! Stage identities describe semantic dependencies, never transient attempts or
//! provider counters. Hosts persist these private artifacts under the job lease.
use super::*;
use serde_json::{Value, json};

pub(super) fn hash(value: &impl Serialize) -> Result<String> {
    Ok(crate::objects::digest(&serde_json::to_vec(value)?))
}
pub(super) fn ready(model: &dyn WikiModel, request: &WikiModelRequest) -> Result<bool> {
    Ok(model.stage_validated_output(request)?.is_some()
        || model.stage_received_response(request)?.is_some()
        || model.cached_json_response(request)?.is_some())
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the stage identity and evidence bindings explicit at this boundary"
)]
pub(super) fn annotate(
    request: &mut WikiModelRequest,
    stage: &'static str,
    node: &str,
    unit: &str,
    label: Option<&str>,
    index: Option<usize>,
    total: Option<usize>,
    dependencies: &[String],
    pages: &[StoredPage],
) -> Result<()> {
    let mut input: Value = serde_json::from_str(&request.user)?;
    input["pipeline"] = json!({"stage":stage,"nodeId":node,"unitKey":unit,
        "unitLabel":label,"unitIndex":index,"totalUnits":total,
        "dependencyHashes":dependencies,"inputPageRevisions":pages.iter().map(|page|
            json!({"pageId":page.draft.page_id,"revisionId":page.revision_id})).collect::<Vec<_>>()});
    request.user = serde_json::to_string(&input)?;
    Ok(())
}

pub(super) fn child(
    parent: &WikiModelRequest,
    request: &mut WikiModelRequest,
    suffix: &str,
    dependencies: &[String],
) -> Result<()> {
    let parent_input: Value = serde_json::from_str(&parent.user)?;
    let Some(metadata) = parent_input.get("pipeline") else {
        return Ok(());
    };
    let mut input: Value = serde_json::from_str(&request.user)?;
    let mut metadata = metadata.clone();
    let node = metadata["nodeId"].as_str().unwrap_or(parent.stage);
    metadata["nodeId"] = json!(format!("{node}/{suffix}"));
    metadata["dependencyHashes"] = json!(dependencies);
    input["pipeline"] = metadata;
    request.user = serde_json::to_string(&input)?;
    Ok(())
}

pub(super) fn failed(
    model: &dyn WikiModel,
    request: &WikiModelRequest,
    error: &anyhow::Error,
) -> Result<()> {
    if let Some(failure) = error.downcast_ref::<WikiCandidateFailure>() {
        model.stage_mark_failed(request, failure.code, &failure.field)
    } else {
        let code = if error.is::<WikiOutputTruncated>() {
            "wiki_output_truncated"
        } else if error.to_string().contains("cancelled") {
            "wiki_cancelled"
        } else {
            "wiki_stage_failed"
        };
        model.stage_mark_failed(request, code, "/")
    }
}
pub(super) fn checked<T>(
    model: &dyn WikiModel,
    request: &WikiModelRequest,
    result: Result<T>,
) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            failed(model, request, &error)?;
            Err(error)
        }
    }
}

pub(super) fn completed<T: Serialize>(
    model: &dyn WikiModel,
    request: &WikiModelRequest,
    value: &T,
) -> Result<()> {
    model.stage_mark_completed(request, &serde_json::to_string(value)?)
}

pub(super) fn validated<T: Serialize>(
    model: &dyn WikiModel,
    request: &WikiModelRequest,
    value: &T,
) -> Result<()> {
    model.stage_mark_validated(request, &serde_json::to_string(value)?)
}

/// Every complete provider response is durable before even JSON syntax parsing.
/// A received response is replay input, never a successful factual certificate.
pub(super) async fn receive(
    model: &dyn WikiModel,
    request: WikiModelRequest,
    context_tokens: usize,
    cancel: &CancellationToken,
) -> Result<String> {
    if let Some(canonical) = model.stage_validated_output(&request)? {
        model.stage_begin(&request)?;
        return Ok(canonical);
    }
    if let Some(raw) = model.stage_received_response(&request)? {
        return Ok(raw);
    }
    model.stage_begin(&request)?;
    let result = call_model_wire(model, request.clone(), context_tokens, cancel).await;
    match result {
        Ok(raw) => {
            // No cancellation branch or parsing occurs between provider finish
            // and this write. The host still checks source identity and lease.
            model.stage_remember_received(&request, &raw)?;
            Ok(raw)
        }
        Err(error) => {
            failed(model, &request, &error)?;
            Err(error)
        }
    }
}
