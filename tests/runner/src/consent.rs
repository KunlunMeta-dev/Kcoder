use anyhow::Result;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default)]
pub struct Consent {
    pub real_model: bool,
    pub external_provider: bool,
    pub windows_vm: bool,
    pub gates: BTreeSet<String>,
}

impl Consent {
    pub fn require(&self, kind: Option<&str>, environment: Option<&str>) -> Result<()> {
        self.require_with(kind, environment, |name| {
            std::env::var(name).as_deref() == Ok("1")
        })
    }

    fn require_with(
        &self,
        kind: Option<&str>,
        environment: Option<&str>,
        enabled: impl Fn(&str) -> bool,
    ) -> Result<()> {
        let Some(kind) = kind else {
            return Ok(());
        };
        let legacy_flag = match kind {
            "real-model" => self.real_model,
            "external-provider" => self.external_provider,
            _ => false,
        };
        anyhow::ensure!(
            legacy_flag || self.gates.contains(kind),
            "suite 需要 --consent {} 显式同意",
            kind
        );
        let variable = environment.ok_or_else(|| anyhow::anyhow!("suite 缺少 consent_env"))?;
        anyhow::ensure!(enabled(variable), "suite 还需要 {variable}=1");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_gate_accepts_non_windows_platform_consent() {
        let consent = Consent {
            gates: BTreeSet::from(["linux-gpu".to_string()]),
            ..Consent::default()
        };
        let result = consent.require_with(Some("linux-gpu"), Some("ALLOW_GPU"), |name| {
            name == "ALLOW_GPU"
        });
        assert!(result.is_ok());
    }
}
