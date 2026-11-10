//! Terminal transfer requests use the existing authenticated Gateway transaction lane.
use crate::cli_args::{MigrationTransferAction, MigrationTransferArgs, TransferRequest};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::{io::Read, path::Path};
#[path = "transfer/batch.rs"]
mod batch;
#[path = "transfer/dispatch.rs"]
mod dispatch;
#[path = "transfer/guide.rs"]
mod guide;
#[path = "transfer/http.rs"]
mod http;
#[path = "transfer/instructions.rs"]
mod instructions;
#[path = "transfer/runtime.rs"]
mod runtime;
#[path = "transfer/validation.rs"]
mod validation;

pub(super) fn run(args: &MigrationTransferArgs, cwd: Option<&Path>) -> Result<()> {
    if let MigrationTransferAction::Guide { options } = &args.action {
        return guide::run(args, options, cwd);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let client = http::Client::open(&args.gateway, &args.access_token_env)?;
        if let MigrationTransferAction::Batch {options}=&args.action {
            return batch::execute(&client,options,cwd).await;
        }
        if let MigrationTransferAction::Targets {page}=args.action {
            let servers = client.servers().await?;
            let values = servers
                .as_array()
                .or_else(|| servers.get("servers").and_then(|v| v.as_array()))
                .ok_or_else(|| anyhow::anyhow!("source_transfer_invalid_response"))?;
            ensure!(
                values.len() <= 1024,
                "source_transfer_response_budget_exceeded"
            );
            ensure!(values.iter().all(|value| value["id"].as_str().is_some_and(|id| !id.is_empty() && id.len()<=64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))) && value["label"].as_str().is_some_and(|label| label.len()<=320 && !label.chars().any(char::is_control)) && matches!(value["transport"].as_str(),Some("local"|"ssh"))),"source_transfer_invalid_response");
            let start=usize::from(page)*10;
            return print(
                &serde_json::json!({"pageIndex":page,"nextPage":(start+10<values.len()).then_some(page+1),"targets": values.iter().skip(start).take(10).map(|value| serde_json::json!({
                "id":value.get("id"), "label":value.get("label"), "transport":value.get("transport")
            })).collect::<Vec<_>>() }),
            );
        }
        dispatch::execute(&client, &args.action, cwd).await
    })
}

fn input(request: &TransferRequest, cwd: Option<&Path>, write: bool) -> Result<Vec<u8>> {
    ensure!(
        !write || request.confirm,
        "source_transfer_confirmation_required"
    );
    let path = super::absolute(&request.input, cwd)?;
    let unavailable = || anyhow::anyhow!("source_transfer_request_unavailable");
    let directory =
        kcoder_config::PrivateDirectory::open_existing(path.parent().ok_or_else(unavailable)?)
            .map_err(|_| unavailable())?;
    directory
        .verify_trusted_config_directory()
        .map_err(|_| unavailable())?;
    let file = directory
        .open_single_link_regular_file(path.file_name().ok_or_else(unavailable)?)
        .map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("source_transfer_request_unavailable"))?;
    ensure!(
        bytes.len() <= 64 * 1024,
        "source_transfer_request_budget_exceeded"
    );
    Ok(bytes)
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("source_transfer_invalid_request"))
}
fn print(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
