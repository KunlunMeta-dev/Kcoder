use super::*;

#[test]
fn project_gitignore_covers_local_runtime_data_only() {
    let temp = TempDir::new().unwrap();
    let path = ensure_project_gitignore(temp.path()).unwrap();
    let content = fs::read_to_string(path).unwrap();

    for rule in PROJECT_GITIGNORE_RULES {
        assert!(content.lines().any(|line| line == *rule), "missing {rule}");
    }
    assert!(!content.lines().any(|line| line == "/settings.json"));
    assert!(!content.contains("/specs/"));
    assert!(!content.contains("/plugins/"));
    assert!(!content.contains("/skills/\n"));
}

#[test]
fn project_gitignore_preserves_custom_rules_and_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join(".kcoder/.gitignore");
    write(
        &path,
        &format!("{PROJECT_GITIGNORE_HEADER}\n/custom-local-data/\n/settings.local.json\n"),
    );

    ensure_project_gitignore(temp.path()).unwrap();
    let once = fs::read_to_string(&path).unwrap();
    ensure_project_gitignore(temp.path()).unwrap();
    let twice = fs::read_to_string(&path).unwrap();

    assert_eq!(once, twice);
    assert!(once.contains("/custom-local-data/"));
    assert_eq!(
        once.lines()
            .filter(|line| *line == "/settings.local.json")
            .count(),
        1
    );
    assert_eq!(once.matches(PROJECT_GITIGNORE_HEADER).count(), 1);
}

#[test]
fn writing_local_settings_does_not_modify_root_gitignore() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    let config = temp.path().join("config");
    fs::create_dir_all(&project).unwrap();
    write(&project.join(".gitignore"), "/target/\n");
    let paths = ConfigPaths::with_config_dir(&project, config);

    write_scope(
        &paths,
        ConfigScope::Local,
        &serde_json::json!({"model": "local-model"}),
    )
    .unwrap();

    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        "/target/\n"
    );
    let nested = fs::read_to_string(project.join(".kcoder/.gitignore")).unwrap();
    assert!(nested.lines().any(|line| line == "/settings.local.json"));
    assert!(nested.lines().any(|line| line == "/settings.json.lock"));
    assert!(
        nested
            .lines()
            .any(|line| line == "/settings.local.json.lock")
    );
    assert!(
        nested
            .lines()
            .any(|line| line == "/settings.local.json.*.tmp")
    );
}

#[test]
fn dotted_values_support_set_get_and_remove() {
    let mut value = Value::Object(Map::new());
    set_dotted_value(
        &mut value,
        "tui.alternate_screen",
        Value::String("never".into()),
    )
    .unwrap();
    assert_eq!(
        dotted_value(&value, "tui.alternate_screen").unwrap(),
        Some(&Value::String("never".into()))
    );
    assert!(remove_dotted_value(&mut value, "tui.alternate_screen").unwrap());
    assert!(
        dotted_value(&value, "tui.alternate_screen")
            .unwrap()
            .is_none()
    );
}

#[test]
fn settings_file_update_preserves_jsonc_comments_and_unchanged_formatting() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    let source = r#"{
  // 根级说明
  "model": "kept-model", // 行尾说明
  "goal_pro": {
    // 独立验证器轮数
    "verifier_max_turns": 16,
  },
  "permission_mode": "ask",
}
"#;
    write(&path, source);

    update_settings_file(&path, |document| {
        set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
    })
    .unwrap();

    let expected = source.replacen(
        "\"verifier_max_turns\": 16",
        "\"verifier_max_turns\": 30",
        1,
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), expected);
}

#[test]
fn settings_file_noop_update_is_byte_for_byte_unchanged() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    let source = b"{\r\n  // no-op must not normalize this file\r\n  \"model\": \"kept\",\r\n}\r\n";
    fs::write(&path, source).unwrap();

    update_settings_file(&path, |_| Ok(())).unwrap();

    assert_eq!(fs::read(&path).unwrap(), source);
}

#[test]
fn scope_update_preserves_jsonc_while_materializing_normalized_fields() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
    let path = paths.for_scope(ConfigScope::User);
    let source = "{\r\n  // 此注释必须保留\r\n  \"model\": \"kept-model\",\r\n  \"permission_mode\": \"ask\",\r\n}\r\n";
    write(path, source);

    update_scope(&paths, ConfigScope::User, |document| {
        set_dotted_value(document, "permission_mode", Value::String("auto".into()))
    })
    .unwrap();

    let updated = fs::read_to_string(path).unwrap();
    assert!(updated.contains("// 此注释必须保留\r\n"));
    assert!(updated.contains("  \"model\": \"kept-model\",\r\n"));
    assert!(updated.contains("  \"permission_mode\": \"auto\",\r\n"));
    assert!(!updated.replace("\r\n", "").contains('\n'));
    let document = read_scope(&paths, ConfigScope::User).unwrap();
    assert_eq!(document["meta"]["config_version"], CURRENT_CONFIG_VERSION);
    assert_eq!(document["permission_mode"], "auto");
}

#[test]
fn duplicate_jsonc_property_change_fails_without_rewriting() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    let source = r#"{
  "goal_pro": {
    "verifier_max_turns": 12,
    "verifier_max_turns": 16
  }
}
"#;
    write(&path, source);

    let error = update_settings_file(&path, |document| {
        set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
    })
    .unwrap_err();

    assert!(error.to_string().contains("duplicate JSONC property"));
    assert_eq!(fs::read_to_string(&path).unwrap(), source);
}

#[test]
fn concurrent_settings_updates_preserve_both_changes_and_comments() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    let source = r#"{
  // 并发更新后仍应保留
  "model": "kept-model",
}
"#;
    write(&path, source);

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let first_path = path.clone();
    let first = std::thread::spawn(move || {
        update_settings_file(&first_path, |document| {
            entered_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            set_dotted_value(document, "permission_mode", Value::String("auto".into()))
        })
        .unwrap();
    });
    entered_rx.recv().unwrap();
    let second_path = path.clone();
    let second = std::thread::spawn(move || {
        update_settings_file(&second_path, |document| {
            set_dotted_value(document, "goal_pro.verifier_max_turns", Value::from(30))
        })
        .unwrap();
    });
    first.join().unwrap();
    second.join().unwrap();

    let updated = fs::read_to_string(&path).unwrap();
    assert!(updated.contains("// 并发更新后仍应保留"));
    assert!(updated.contains("  \"model\": \"kept-model\","));
    let document = read_settings_file(&path).unwrap();
    assert_eq!(document["permission_mode"], "auto");
    assert_eq!(document["goal_pro"]["verifier_max_turns"], 30);
}

#[test]
fn concurrent_scope_updates_share_one_read_modify_write_lock() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let first_paths = paths.clone();
    let first = std::thread::spawn(move || {
        update_scope(&first_paths, ConfigScope::User, |document| {
            entered_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            set_dotted_value(
                document,
                "tui.alternate_screen",
                Value::String("never".into()),
            )
        })
        .unwrap();
    });
    entered_rx.recv().unwrap();
    let second_paths = paths.clone();
    let second = std::thread::spawn(move || {
        update_scope(&second_paths, ConfigScope::User, |document| {
            set_dotted_value(document, "permission_mode", Value::String("ask".into()))
        })
        .unwrap();
    });
    first.join().unwrap();
    second.join().unwrap();

    let document = read_scope(&paths, ConfigScope::User).unwrap();
    assert_eq!(document["tui"]["alternate_screen"], "never");
    assert_eq!(document["permission_mode"], "ask");
}

#[test]
fn create_if_missing_uses_the_scope_lock_and_publishes_atomically() {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
    let settings_path = paths.for_scope(ConfigScope::User).to_path_buf();
    let lock = lock_settings_path(&settings_path).unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker_paths = paths.clone();
    let worker = std::thread::spawn(move || {
        let result = write_scope_if_missing(
            &worker_paths,
            ConfigScope::User,
            &serde_json::json!({"model": "created-under-lock"}),
        );
        done_tx.send(result).unwrap();
    });

    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_err()
    );
    assert!(!settings_path.exists());
    FileExt::unlock(&lock).unwrap();

    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap()
    );
    worker.join().unwrap();
    assert_eq!(
        read_scope(&paths, ConfigScope::User).unwrap()["model"],
        "created-under-lock"
    );
}
