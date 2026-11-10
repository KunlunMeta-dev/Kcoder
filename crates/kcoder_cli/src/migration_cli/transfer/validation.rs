//! Read observations must not turn an unknown outcome into confirmed readiness.
use anyhow::{Result, ensure};
use kcoder_app_protocol::*;
use serde_json::Value;

fn valid(value: bool) -> Result<()> {
    ensure!(value, "source_transfer_invalid_response");
    Ok(())
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn count(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|n| n <= max)
}
fn code(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|s| {
            s.len() <= 128
                && s.starts_with("source_transfer_")
                && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
}
fn receipt(value: &Value, id: &str) -> bool {
    value["requestId"] == id
        && digest(&value["manifestSha256"])
        && value["entries"]
            .as_u64()
            .is_some_and(|n| (1..=1024).contains(&n))
        && count(&value["bytes"], 2 * 1024 * 1024 * 1024)
}
pub(super) fn observation(result: &MigrationSourceTransferResult, id: &str) -> Result<()> {
    let value = serde_json::to_value(result)?;
    valid(
        code(&value["errorCode"])
            && value["requestId"] == id
            && (value["observation"] == "observed") != value["result"].is_null(),
    )?;
    let progress = &value["progress"];
    if !progress.is_null() {
        valid(progress["requestId"] == id)?;
        if progress["phase"] == "transferring" {
            valid(
                progress["entries"]
                    .as_u64()
                    .is_some_and(|n| (1..=1024).contains(&n))
                    && count(&progress["totalBytes"], 2 * 1024 * 1024 * 1024)
                    && count(&progress["acceptedBytes"], 2 * 1024 * 1024 * 1024)
                    && progress["acceptedBytes"].as_u64() <= progress["totalBytes"].as_u64(),
            )?;
        }
    }
    let result = &value["result"];
    if result.is_null() {
        return Ok(());
    }
    if result.get("scope").is_none() {
        valid(code(&result["sourceCapture"]["errorCode"]))?;
    }
    valid(
        result["requestId"] == id
            && !(result["phase"] == "ready" && result["receipt"].is_null())
            && result["targetState"]["ready"].as_bool().unwrap_or(false)
                != result["receipt"].is_null()
            && result["targetAdmissionControl"]["ready"] != true,
    )?;
    if !result["receipt"].is_null() {
        valid(receipt(&result["receipt"], id))?;
    }
    if result.get("scope").is_some() {
        valid(result["sourceObserved"] == false)?;
        let progress = &result["progress"];
        valid(result["targetState"].is_null() == progress.is_null())?;
        if !progress.is_null() {
            valid(
                progress["entries"]
                    .as_u64()
                    .is_some_and(|n| (1..=1024).contains(&n))
                    && digest(&progress["manifestSha256"])
                    && count(&progress["totalBytes"], 2 * 1024 * 1024 * 1024)
                    && count(&progress["acceptedBytes"], 2 * 1024 * 1024 * 1024)
                    && progress["acceptedBytes"].as_u64() <= progress["totalBytes"].as_u64()
                    && progress["partsComplete"]
                        == (progress["acceptedBytes"] == progress["totalBytes"]),
            )?;
            if !result["receipt"].is_null() {
                valid(
                    result["receipt"]["manifestSha256"] == progress["manifestSha256"]
                        && result["receipt"]["bytes"] == progress["totalBytes"]
                        && progress["partsComplete"] == true,
                )?;
            }
        }
    }
    Ok(())
}
pub(super) fn adoption(
    result: &MigrationSourceAdoptionResult,
    locator: &MigrationSourceAdoptionParams,
) -> Result<()> {
    if let MigrationSourceNullable::Value(state) = &result.state {
        valid(code(&serde_json::to_value(&state.error_code)?))?;
        valid(
            state.request_id == locator.request_id
                && state.adoption_id == locator.adoption_id
                && state.completed_sources <= state.total_sources
                && state.total_sources <= 64
                && state
                    .jobs
                    .iter()
                    .map(|j| &j.job_id)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == state.jobs.len()
                && (state.phase != MigrationSourceAdoptionPhase::PreviewReady
                    || state.completed_sources == state.total_sources),
        )?;
    }
    Ok(())
}
pub(super) fn received(
    result: &MigrationSourceReceivedResult,
    params: &MigrationSourceReceivedParams,
) -> Result<()> {
    valid(
        result.receipt.request_id == params.request_id
            && result.receipt.manifest_sha256 == params.manifest_sha256
            && result.items.len() <= 10
            && result.items.iter().all(|row| {
                if row.class == MigrationSourceReceivedClass::Project {
                    params.include_projects
                        && !row.project_scoped
                        && matches!(
                            row.category,
                            MigrationSourceNullable::Value(
                                kcoder_types::migration::MigrationCategory::Project
                            )
                        )
                        && row
                            .project
                            .as_ref()
                            .is_some_and(|metadata| metadata.roots > 0 && metadata.roots <= 16)
                } else {
                    row.project.is_none()
                }
            })
            && result.total_sources <= 1024
            && result
                .items
                .iter()
                .map(|i| &i.entry_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == result.items.len()
            && match result.next_page {
                MigrationSourceNullable::Null(()) => true,
                MigrationSourceNullable::Value(page) => page == params.page_index + 1,
            },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn contradictory_or_secret_bearing_observations_never_become_terminal_readiness() {
        let id = "11111111-1111-4111-8111-111111111111";
        let base = json!({"requestId":id,"coordinatorState":"idle","observation":"unobserved","result":null,"progress":null,"errorCode":null});
        let parse =
            |value: Value| serde_json::from_value::<MigrationSourceTransferResult>(value).unwrap();
        assert!(observation(&parse(base.clone()), id).is_ok());
        let mut wrong = base.clone();
        wrong["observation"] = json!("observed");
        assert!(observation(&parse(wrong), id).is_err());
        let mut secret = base;
        secret["errorCode"] = json!("PRIVATE_RESPONSE_SECRET");
        assert!(observation(&parse(secret), id).is_err());
    }
    #[test]
    fn transferring_progress_rejects_zero_or_excess_entries_even_when_bytes_are_plausible() {
        let id = "11111111-1111-4111-8111-111111111111";
        for entries in [0, 1, 1024, 1025] {
            let value = json!({"requestId":id,"coordinatorState":"running","observation":"unobserved","result":null,"progress":{"phase":"transferring","requestId":id,"entries":entries,"totalBytes":100,"acceptedBytes":50},"errorCode":null});
            let result = serde_json::from_value(value).unwrap();
            assert_eq!(
                observation(&result, id).is_ok(),
                (1..=1024).contains(&entries)
            );
        }
    }
}
