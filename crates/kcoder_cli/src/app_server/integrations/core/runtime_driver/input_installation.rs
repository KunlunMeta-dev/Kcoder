//! Exact installed input identity for protected application tasks.
use anyhow::{Context, Result, ensure};
use kcoder_engine::{QueryEngine, integrations::core::NativeInputContextIdentity};
use std::sync::OnceLock;

/// Owned by one accepted native operation. This only recognizes the exact
/// installed input object; source authorization remains with that operation.
#[derive(Default)]
pub(crate) struct NativeInputInstallation {
    identity: OnceLock<NativeInputContextIdentity>,
}
impl NativeInputInstallation {
    pub(crate) fn permits_reuse(&self, engine: &QueryEngine) -> Result<bool> {
        let Some(original) = self.identity.get() else {
            return Ok(false);
        };
        ensure!(
            engine.matches_native_input_context_identity(original) == Some(true),
            "NATIVE_INPUT_CONTEXT_CHANGED"
        );
        Ok(true)
    }

    pub(crate) fn record_installed(&self, engine: &QueryEngine) -> Result<()> {
        let input = engine
            .native_input_context_identity()
            .context("NATIVE_INPUT_CONTEXT_UNAVAILABLE")?;
        self.identity
            .set(input)
            .map_err(|_| anyhow::anyhow!("NATIVE_INPUT_CONTEXT_ALREADY_INSTALLED"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn installed_input_reuses_only_its_original_identity() -> Result<()> {
        let root = tempfile::tempdir()?;
        let runtime = crate::app_server::thread_runtime::test_support::test_runtime(
            "input-installation",
            &root.path().join("placeholder.jsonl"),
        );
        let result = (|| -> Result<()> {
            let engine = runtime
                .engine()
                .with_native_input_only_context("original input".into(), 128)?;
            let recreated = engine
                .clone()
                .with_native_input_only_context("original input".into(), 128)?;
            let installation = NativeInputInstallation::default();
            ensure!(!installation.permits_reuse(&engine)?);
            installation.record_installed(&engine)?;
            ensure!(installation.permits_reuse(&engine.clone())?);
            ensure!(installation.permits_reuse(&recreated).is_err());
            ensure!(installation.record_installed(&recreated).is_err());
            Ok(())
        })();
        runtime.shutdown().await;
        result
    }
}
