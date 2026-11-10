use super::*;

#[test]
fn dispatch_is_enabled_by_default_and_stays_on_for_legacy_settings() {
    assert!(ContinuousWorkSettings::default().dispatch_enabled());
    let legacy: ContinuousWorkSettings = serde_json::from_str("{}").unwrap();
    assert!(legacy.dispatch_enabled());
    let explicit: ContinuousWorkSettings =
        serde_json::from_str(r#"{"dispatch_enabled":false}"#).unwrap();
    assert!(!explicit.dispatch_enabled());
}

#[test]
fn embedded_schema_accepts_the_valve_and_rejects_unknown_keys() {
    let accepted = serde_json::json!({"continuous_work": {"dispatch_enabled": false}});
    crate::schema::validate_settings_schema(&accepted).unwrap();
    let rejected = serde_json::json!({"continuous_work": {"auto_continue": true}});
    assert!(crate::schema::validate_settings_schema(&rejected).is_err());
    let wrong_type = serde_json::json!({"continuous_work": {"dispatch_enabled": "yes"}});
    assert!(crate::schema::validate_settings_schema(&wrong_type).is_err());
}

#[test]
fn legacy_settings_keep_the_valve_enabled_and_explicit_false_round_trips() {
    let legacy: crate::Settings = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(legacy.continuous_work.dispatch_enabled());
    assert!(
        crate::Settings::default()
            .continuous_work
            .dispatch_enabled()
    );

    let disabled: crate::Settings =
        serde_json::from_value(serde_json::json!({"continuous_work": {"dispatch_enabled": false}}))
            .unwrap();
    assert!(!disabled.continuous_work.dispatch_enabled());

    let value = serde_json::to_value(&disabled).unwrap();
    assert_eq!(value["continuous_work"]["dispatch_enabled"], false);
}

fn child_reports_valve(profile: &std::path::Path) -> Result<(), String> {
    let loaded = crate::Settings::load_for_cwd(profile)
        .map_err(|error| format!("child load failed: {error:#}"))?;
    println!(
        "CONTINUOUS_WORK_VALVE={}",
        loaded.settings.continuous_work.dispatch_enabled()
    );
    Ok(())
}

/// The valve is read from the configuration file by each process, so closing it
/// takes effect for a newly started host without touching the writer's state.
#[test]
fn a_second_process_reads_the_closed_valve_from_the_same_file() {
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_VALVE_PROFILE") {
        let _ = child_reports_valve(std::path::Path::new(&profile));
        return;
    }
    let profile = crate::create_private_temp_dir("continuous-work-valve").expect("temp dir");
    std::fs::write(
        profile.path().join("settings.json"),
        br#"{"continuous_work":{"dispatch_enabled":false}}"#,
    )
    .expect("write settings");
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([
            "--exact",
            "settings::continuous_work::tests::a_second_process_reads_the_closed_valve_from_the_same_file",
            "--nocapture",
        ])
        .env("KCODER_TEST_CONTINUOUS_VALVE_PROFILE", profile.path())
        .env("KCODER_CONFIG_DIR", profile.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("spawn child");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "stdout={stdout} stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("CONTINUOUS_WORK_VALVE=false"),
        "child did not report a closed valve: {stdout}"
    );
}
