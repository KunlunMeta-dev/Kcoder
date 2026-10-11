use super::*;

#[test]
fn context_compaction_threshold_percentages_are_configurable() {
    let settings: Settings = serde_json::from_str(
        r#"{
                "context_compaction": {
                    "auto_threshold": {
                        "small_window_percent": 90,
                        "medium_window_percent": 80,
                        "large_window_percent": 70
                    }
                }
            }"#,
    )
    .unwrap();

    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .percentage_for(128_000),
        90
    );
    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .percentage_for(512_000),
        80
    );
    assert_eq!(
        settings
            .context_compaction
            .auto_threshold
            .percentage_for(1_000_000),
        70
    );
}

#[test]
fn time_based_micro_compact_settings_are_independently_configurable() {
    let settings: Settings = serde_json::from_str(
        r#"{
                "time_based_micro_compact": {
                    "enabled": false,
                    "gap_threshold_minutes": 90,
                    "keep_recent": 8
                }
            }"#,
    )
    .unwrap();

    assert!(!settings.time_based_micro_compact.enabled);
    assert_eq!(settings.time_based_micro_compact.gap_threshold_minutes, 90);
    assert_eq!(settings.time_based_micro_compact.keep_recent, 8);
}

#[test]
fn summary_defaults_fall_back_to_main_runtime() {
    assert_eq!(Settings::default().summary_provider, None);
    assert_eq!(Settings::default().summary_profile, None);
    assert_eq!(Settings::default().summary_model, None);

    let loaded: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(loaded.summary_provider, None);
    assert_eq!(loaded.summary_profile, None);
    assert_eq!(loaded.summary_model, None);
}

#[test]
fn settings_normalize_rejects_a_zero_history_limit() {
    let mut settings = Settings {
        history_max_messages: 0,
        ..Settings::default()
    };

    settings.normalize_runtime_limits();

    assert_eq!(settings.history_max_messages, 1);
}
