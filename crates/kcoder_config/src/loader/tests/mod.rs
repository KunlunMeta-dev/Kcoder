use super::*;

use tempfile::TempDir;

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn write_escalation_config(config: &Path, goal_pro: &str) {
    fs::create_dir_all(config).unwrap();
    let content = format!(
        r#"{{
                "active_provider": "main",
                "providers": {{
                    "main": {{
                        "provider": "main",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://main.example/anthropic",
                        "model": "main-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-same": {{
                        "provider": "ladder-same",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://ladder.example/anthropic",
                        "model": "ladder-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-other-format": {{
                        "provider": "ladder-other-format",
                        "api_format": "openai_responses",
                        "endpoint": "https://ladder.example/v1",
                        "model": "ladder-model",
                        "context_window_tokens": 200000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }},
                    "ladder-other-window": {{
                        "provider": "ladder-other-window",
                        "api_format": "anthropic_messages",
                        "endpoint": "https://ladder.example/anthropic",
                        "model": "ladder-model",
                        "context_window_tokens": 128000,
                        "output_headroom_tokens": 20000,
                        "max_output_tokens": 20000
                    }}
                }},
                {goal_pro}
            }}"#
    );
    write(&config.join("settings.json"), &content);
}

fn load_escalation_error(goal_pro: &str) -> Option<String> {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("config");
    fs::create_dir_all(&project).unwrap();
    write_escalation_config(&config, goal_pro);
    SettingsLoader::new(&project)
        .with_config_dir(&config)
        .load()
        .err()
        .map(|error| format!("{error:#}"))
}

mod credentials;
mod discovery;
mod layers;
mod persistence;
mod validation;
