//! Read-only actual-store diagnostic for an owned native host fixture, never an authority producer.
#[path = "../src/app_server/integrations/connectivity/control/observation.rs"]
mod control;
use anyhow::{Context, Result};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use std::{ffi::OsStr, path::PathBuf};
fn observed<T>(
    stage: &'static str,
    result: Result<T>,
    report: &mut Vec<serde_json::Value>,
) -> Option<T> {
    match result {
        Ok(value) => {
            report.push(serde_json::json!({"stage":stage,"ok":true}));
            Some(value)
        }
        Err(error) => {
            let message = error.to_string();
            report.push(serde_json::json!({"stage":stage,"ok":false,"message":message.chars().take(512).collect::<String>(),
                "ioCode":error.chain().find_map(|cause|cause.downcast_ref::<std::io::Error>().and_then(std::io::Error::raw_os_error)),
                "serdeCategory":error.chain().find_map(|cause|cause.downcast_ref::<serde_json::Error>().map(|error|format!("{:?}",error.classify())))}));
            None
        }
    }
}
fn run(report: &mut Vec<serde_json::Value>) -> Result<()> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("Explicit existing owned store required")?,
    );
    let directory = PrivateDirectory::open_existing(&root)?;
    directory.verify_private_directory()?;
    let initial = directory.open_single_link_regular_file(OsStr::new(control::INIT))?;
    let identity = PortableLeaseIdentity::from_regular_handle(&initial)?;
    let initial = control::read_initialization(&initial)?;
    observed(
        "read_log",
        control::read_log(
            &directory.open_single_link_regular_file(OsStr::new(control::LOG))?,
            &initial,
            &identity,
        ),
        report,
    );
    let data = control::data_directory(&directory, &initial)?;
    let namespace = root
        .file_name()
        .and_then(|name| name.to_str())
        .context("Store namespace missing")?;
    observed(
        "verify_node_store",
        control::verify_node_store(&directory, &data, namespace, &initial),
        report,
    );
    Ok(())
}
fn main() {
    let mut report = Vec::new();
    let result = run(&mut report);
    if let Err(error) = result {
        observed::<()>("probe", Err(error), &mut report);
    }
    println!(
        "{}",
        serde_json::to_string(&report).expect("finite owned diagnostic serializes")
    );
}
