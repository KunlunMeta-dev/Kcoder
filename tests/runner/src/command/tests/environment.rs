#[test]
fn selected_custom_credential_is_forwarded_without_inheriting_other_environment() {
    let suite = Suite {
        id: "real-model".to_string(),
        tiers: vec!["real-model".to_string()],
        command: vec!["true".to_string()],
        summary: None,
        cwd: None,
        timeout_seconds: 1,
        requires_commands: vec![],
        requires_files: vec![],
        required_artifacts: vec![],
        requires_env: vec![],
        requires_executables: vec![],
        requires_any_env: vec![],
        platforms: vec![],
        pass_env: vec!["KCODER_E2E_MODEL_CREDENTIAL_ENV".to_string()],
        secret_env: vec![],
        secret_env_selectors: vec!["KCODER_E2E_MODEL_CREDENTIAL_ENV".to_string()],
        env: Default::default(),
        consent: Some("real-model".to_string()),
        consent_env: Some("KCODER_E2E_REAL_MODEL".to_string()),
        depends_on: vec![],
        setup: false,
    };
    let selected = selected_credential_environment(&suite, |name| match name {
        "KCODER_E2E_MODEL_CREDENTIAL_ENV" => Some("CUSTOM_API_KEY".into()),
        "CUSTOM_API_KEY" => Some("custom-secret-value".into()),
        "UNRELATED_API_KEY" => Some("must-not-pass".into()),
        _ => None,
    })
    .unwrap();

    assert_eq!(
        selected,
        Some(("CUSTOM_API_KEY".to_string(), "custom-secret-value".into()))
    );
}
