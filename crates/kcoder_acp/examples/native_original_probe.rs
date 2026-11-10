//! Actual executable probe with separate no-turn and local wire Provider scenarios.
use anyhow::{Context, Result, ensure};
use kcoder_test_harness::{
    ModelPolicy, OwnedProcess, RunContext, RunMetadata, RunStatus, TestTier,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    ensure!(
        cfg!(target_os = "linux"),
        "UNMET_PREREQUISITE: Linux pidfd/procfs required"
    );
    let mut args = std::env::args_os().skip(1);
    let binary = PathBuf::from(
        args.next()
            .context("explicit immutable normal binary required")?,
    )
    .canonicalize()?;
    let evidence = PathBuf::from(args.next().context("explicit evidence root required")?);
    let scenario = args.next().unwrap_or_else(|| "bind-only".into());
    ensure!(
        args.next().is_none(),
        "expected binary, evidence root and optional scenario only"
    );
    ensure!(
        [
            "bind-only",
            "local-provider",
            "office-docx",
            "materials-transfer",
            "materials-prefinish-session",
            "materials-offset",
            "materials-conflict",
            "materials-ack-unknown",
            "materials-source-docx"
        ]
        .iter()
        .any(|allowed| scenario == *allowed),
        "unsupported explicit scenario"
    );
    let mut context = RunContext::create(
        evidence,
        RunMetadata::new(
            format!("acp-native-original-actual-{}", scenario.to_string_lossy()),
            TestTier::Pr,
            ModelPolicy::Forbidden,
        ),
    )?;
    context.register_secret("C58_PRIVATE_ORIGINAL_PROBE")?;
    let private = tempfile::tempdir()?;
    let report = context.artifact_path("actual-process-report.json")?;
    let kept_report = report.clone();
    let workspace = private.path().to_owned();
    context.register_cleanup(move || {
        let clean = std::fs::read(&kept_report)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| {
                value["cleanup"]["allObservedExited"] == true
                    && value["cleanup"]["monitorComplete"] == true
            });
        if !clean {
            let retained = private.keep();
            anyhow::bail!(
                "Actual probe cleanup unconfirmed; isolated state retained: {}",
                retained.display()
            );
        }
        private.close().map_err(Into::into)
    });
    let script = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_acp")
        .join("examples/native_original_probe.py");
    let mut command = Command::new("/usr/bin/python3");
    command.env_clear().env("PATH", "/usr/bin:/bin").args([
        script.as_os_str(),
        binary.as_os_str(),
        workspace.as_os_str(),
        report.as_os_str(),
        scenario.as_os_str(),
    ]);
    if scenario == "office-docx" {
        command.env(
            "KCODER_ACP_OFFICE_OBSERVATION",
            std::env::var_os("KCODER_ACP_OFFICE_OBSERVATION")
                .context("explicit sealed Office observation required")?,
        );
    }
    let child = Arc::new(Mutex::new(OwnedProcess::spawn_exact_environment(
        &mut command,
    )?));
    let cleanup = child.clone();
    context.register_cleanup(move || {
        cleanup.lock().unwrap().terminate(Duration::from_secs(5))?;
        Ok(())
    });
    let result = (|| -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(status) = child.lock().unwrap().try_wait()? {
                ensure!(
                    status.success(),
                    "Actual ACP probe failed; inspect owned report"
                );
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "Actual ACP probe deadline exceeded; receipt unknown"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let value: Value = serde_json::from_slice(&std::fs::read(&report)?)?;
        ensure!(
            value["passed"] == true
                && value["cleanup"]["allObservedExited"] == true
                && value["cleanup"]["monitorComplete"] == true,
            "Actual probe did not complete"
        );
        context.write_artifact_json("validated-process-report.json", &value)?;
        context.write_artifact_json("receipt.json", &json!({"binary":binary,"driverSha256":value["driverSha256"],"binarySha256":value["binarySha256"],"modelPolicy":"local fixture only; no paid provider","scenario":value["scenario"],"turnStartSent":value["turnStartSent"],"sourceRealBudget":false,"passed":true}))?;
        Ok(())
    })();
    let status = if result.is_ok() {
        RunStatus::Passed
    } else {
        RunStatus::Failed
    };
    let message = result.as_ref().err().map(|error| error.to_string());
    let cleanup = context.finish(status, message.as_deref())?;
    println!("{}", context.root().display());
    ensure!(cleanup.failures.is_empty(), "Actual probe cleanup failed");
    result
}
