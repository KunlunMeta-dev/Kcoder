//! A received preview is published only through the existing selected-target batch API.
use super::*;
use crate::cli_args::{MigrationRemoteBatchArgs, RemoteBatchOperation as B};
use kcoder_app_protocol::*;
use std::time::{Duration, Instant};

pub(super) async fn execute(
    http: &http::Client,
    args: &MigrationRemoteBatchArgs,
    cwd: Option<&Path>,
) -> Result<()> {
    let bytes = input(
        &args.request,
        cwd,
        !matches!(args.operation, B::Read | B::Items),
    )?;
    let (base, authorization) = http.runtime_authority()?;
    let rpc_token = http::rpc_marker(args.rpc_token_env.as_deref())?;
    let mut client = super::runtime::Client::connect(
        &base,
        &authorization,
        &rpc_token,
        &args.target_id,
        args.workspace_path.as_deref(),
    )
    .await?;
    http.current()?;
    let result = call(&mut client, http, args, &bytes).await;
    let release = client.close().await;
    http.current()?;
    let value = result?;
    print(
        &serde_json::json!({"targetId":args.target_id,"result":value,"connectionRelease":if release.is_ok(){"released"}else{"unknown"}}),
    )
}

async fn call(
    client: &mut super::runtime::Client,
    http: &http::Client,
    args: &MigrationRemoteBatchArgs,
    bytes: &[u8],
) -> Result<serde_json::Value> {
    let value = match args.operation {
        B::Read => {
            let params: MigrationOperationParams = decode(bytes)?;
            client.require(CAPABILITY_MIGRATION_BATCH_WORKERS_V1)?;
            let result: MigrationBatchStateResult =
                client.call(method::MIGRATION_BATCH_READ, &params).await?;
            ensure!(
                result.state.job.job_id == params.job_id,
                "migration_remote_invalid_response"
            );
            serde_json::to_value(result)?
        }
        B::Items => {
            let params: MigrationItemsParams = decode(bytes)?;
            let result: MigrationItemsResult =
                client.call(method::MIGRATION_ITEMS, &params).await?;
            ensure!(
                result.items.len() <= 10,
                "migration_remote_invalid_response"
            );
            serde_json::to_value(result)?
        }
        B::Plan => {
            let params: MigrationBatchPlanParams = decode(bytes)?;
            if params.project_mcp_inheritance.is_some() {
                client.require(CAPABILITY_MIGRATION_PROJECT_MCP_INHERITANCE_V1)?;
            }
            let result: MigrationJobReadResult =
                client.call(method::MIGRATION_BATCH_PLAN, &params).await?;
            ensure!(
                result.job.job_id == params.job_id,
                "migration_remote_invalid_response"
            );
            serde_json::to_value(result)?
        }
        B::Run => {
            client.require(CAPABILITY_MIGRATION_BATCH_WORKERS_V1)?;
            let params: MigrationBatchRunParams = decode(bytes)?;
            let mut result: MigrationBatchStateResult =
                client.call(method::MIGRATION_BATCH_RUN, &params).await?;
            let deadline = Instant::now() + Duration::from_secs(args.wait_seconds);
            loop {
                http.current()?;
                ensure!(
                    result.state.job.job_id == params.job_id,
                    "migration_remote_invalid_response"
                );
                if !result.worker_running || Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                result = client
                    .call(
                        method::MIGRATION_BATCH_READ,
                        &MigrationOperationParams {
                            job_id: params.job_id.clone(),
                        },
                    )
                    .await?;
            }
            serde_json::to_value(result)?
        }
        B::Cancel => {
            let params: MigrationCancelParams = decode(bytes)?;
            let result: MigrationJobReadResult =
                client.call(method::MIGRATION_CANCEL, &params).await?;
            ensure!(
                result.job.job_id == params.job_id,
                "migration_remote_invalid_response"
            );
            serde_json::to_value(result)?
        }
    };
    http.current()?;
    Ok(value)
}
