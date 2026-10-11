use crate::matrix::Suite;
use anyhow::{Context, Result};
use kcoder_test_harness::RunContext;

pub fn register_passed_secrets(context: &mut RunContext, suites: &[&Suite]) -> Result<()> {
    register_passed_secrets_from(context, suites, |name| std::env::var(name).ok())
}

fn register_passed_secrets_from(
    context: &mut RunContext,
    suites: &[&Suite],
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<()> {
    for suite in suites {
        for name in &suite.secret_env {
            if let Some(value) = lookup(name).filter(|value| !value.is_empty()) {
                context
                    .register_secret(value)
                    .with_context(|| format!("secret env {name} 无法安全脱敏"))?;
            }
        }
        for selector in &suite.secret_env_selectors {
            let Some(selected_name) = lookup(selector) else {
                continue;
            };
            anyhow::ensure!(
                valid_dynamic_env_name(&selected_name),
                "secret selector {selector} 包含无效环境变量名"
            );
            if let Some(value) = lookup(&selected_name).filter(|value| !value.is_empty()) {
                context
                    .register_secret(value)
                    .with_context(|| format!("selector secret {selected_name} 无法安全脱敏"))?;
            }
        }
    }
    Ok(())
}

fn valid_dynamic_env_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix::TestMatrix;
    use kcoder_test_harness::{ModelPolicy, RunMetadata, TestTier};

    fn context(path: &std::path::Path) -> RunContext {
        RunContext::create(
            path,
            RunMetadata::new("credential", TestTier::Unit, ModelPolicy::Forbidden),
        )
        .unwrap()
    }

    #[test]
    fn short_credential_is_rejected_before_execution() {
        let temporary = tempfile::tempdir().unwrap();
        let mut context = context(temporary.path());
        let matrix: TestMatrix = toml::from_str("schema_version=2\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']\nconsent='real-model'\nconsent_env='ALLOW_LIVE'\npass_env=['ALLOW_LIVE','API_KEY']\nsecret_env=['API_KEY']").unwrap();
        let error = register_passed_secrets_from(&mut context, &[&matrix.suite[0]], |name| {
            (name == "API_KEY").then(|| "short".into())
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("API_KEY"));
    }

    #[test]
    fn selected_custom_credential_is_registered() {
        let temporary = tempfile::tempdir().unwrap();
        let mut context = context(temporary.path());
        let matrix: TestMatrix = toml::from_str("schema_version=2\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']\nconsent='real-model'\nconsent_env='ALLOW_LIVE'\npass_env=['ALLOW_LIVE','SELECTOR']\nsecret_env_selectors=['SELECTOR']").unwrap();
        register_passed_secrets_from(&mut context, &[&matrix.suite[0]], |name| match name {
            "SELECTOR" => Some("CUSTOM_API_KEY".into()),
            "CUSTOM_API_KEY" => Some("custom-secret-value".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(
            context.redact_text("x custom-secret-value y"),
            "x [REDACTED] y"
        );
    }
}
