use super::*;
use serde_json::{Value, json};
use std::path::Path;

fn materialize(value: &Value, home: &Path) -> Value {
    if let Some(parts) = value.get("path").and_then(Value::as_array) {
        let mut path = PathBuf::new();
        for part in parts {
            let part = part.as_str().unwrap();
            if part == "$home" {
                path.push(home);
            } else {
                path.push(part);
            }
        }
        return json!(path);
    }
    match value {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| materialize(value, home))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), materialize(value, home)))
                .collect(),
        ),
        value => value.clone(),
    }
}

#[test]
fn shared_owned_child_context_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/storage-locations.json"
    ))
    .unwrap();
    let owned = tempfile::tempdir().unwrap();
    for raw in fixture["startupContexts"].as_array().unwrap() {
        let entry = materialize(raw, owned.path());
        let run = || -> anyhow::Result<Value> {
            let context = super::context::decode(OsStr::new(&entry["context"].to_string()))?;
            let env = entry
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .map(|(name, value)| {
                            (name.clone(), OsString::from(value.as_str().unwrap()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::to_value(load_storage_paths(
                StorageResolveInput {
                    home: Some(owned.path().to_owned()),
                    env,
                    startup_context: Some(context),
                    ..Default::default()
                },
            )?)?)
        };
        if let Some(error) = entry["error"].as_str() {
            assert_eq!(run().unwrap_err().to_string(), error, "{}", entry["name"]);
        } else {
            let actual = run().unwrap();
            for (key, expected) in entry["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], expected, "{}: {key}", entry["name"]);
            }
        }
    }
    assert!(std::fs::read_dir(owned.path()).unwrap().next().is_none());
}

#[test]
fn shared_storage_location_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/storage-locations.json"
    ))
    .unwrap();
    let schema: Value = serde_json::from_str(include_str!(
        "../../../kcoder_types/schema/storage-location.schema.json"
    ))
    .unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path().join("user");
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    for case in fixture["cases"].as_array().unwrap() {
        if case
            .get("platforms")
            .and_then(Value::as_array)
            .is_some_and(|platforms| !platforms.iter().any(|value| value == platform))
        {
            continue;
        }
        let case = materialize(case, &home);
        let mut input = StorageResolveInput {
            home: Some(home.clone()),
            platform_config: Some(home.join("platform")),
            env: case
                .get("env")
                .map(|value| {
                    serde_json::from_value::<BTreeMap<String, String>>(value.clone())
                        .unwrap()
                        .into_iter()
                        .map(|(key, value)| (key, value.into()))
                        .collect()
                })
                .unwrap_or_default(),
            development: case["development"].as_bool().unwrap_or(false),
            consumer: match case["consumer"].as_str() {
                Some("desktop") => StorageConsumer::Desktop,
                Some("gateway") => StorageConsumer::Gateway,
                _ => StorageConsumer::Cli,
            },
            ..Default::default()
        };
        let result = (|| -> anyhow::Result<Value> {
            if !input.ignores_personal_selection() {
                if case.get("error").is_none() {
                    if let Some(record) = case.get("record") {
                        assert!(validator.is_valid(record), "{}", case["name"]);
                    }
                }
                input.record = case
                    .get("record")
                    .map(|value| {
                        serde_json::from_value(value.clone())
                            .map_err(|_| anyhow::anyhow!("STORAGE_RECORD_INVALID"))
                    })
                    .transpose()?;
            }
            Ok(serde_json::to_value(resolve_storage_paths(&input)?)?)
        })();
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), error, "{}", case["name"]);
        } else {
            let result = result.unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            for (field, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&result[field], expected, "{}: {field}", case["name"]);
            }
        }
    }
    assert!(!home.exists(), "pure resolution must not create a profile");
}

#[test]
fn bounded_record_reads_preserve_content_and_do_not_initialize_missing_locations() {
    let owned = tempfile::tempdir().unwrap();
    let missing = owned.path().join("missing").join("kcoder-storage.json");
    assert_eq!(read_storage_location_record(&missing).unwrap(), None);
    assert!(!missing.parent().unwrap().exists());
    let path = owned.path().join("location.json");
    let data = json!({"version":1,"revision":1,"dataRoot":owned.path().join("Data"),"cacheRoot":owned.path().join("Cache")});
    let original = serde_json::to_vec(&data).unwrap();
    std::fs::write(&path, &original).unwrap();
    for _ in 0..3 {
        assert_eq!(
            read_storage_location_record(&path)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
    }
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(!owned.path().join("Data").exists());
    std::fs::write(
        &path,
        vec![b' '; kcoder_types::STORAGE_LOCATION_MAX_BYTES as usize + 1],
    )
    .unwrap();
    assert_eq!(
        read_storage_location_record(&path).unwrap_err().to_string(),
        "STORAGE_RECORD_INVALID"
    );
    std::fs::write(&path, b"{bad}").unwrap();
    assert_eq!(
        read_storage_location_record(&path).unwrap_err().to_string(),
        "STORAGE_RECORD_INVALID"
    );
}

#[test]
fn linked_records_do_not_redirect_storage() {
    let owned = tempfile::tempdir().unwrap();
    let path = owned.path().join("directory");
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        read_storage_location_record(&path).unwrap_err().to_string(),
        "STORAGE_RECORD_INVALID"
    );
    #[cfg(unix)]
    {
        let link = owned.path().join("location.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(
            read_storage_location_record(&link).unwrap_err().to_string(),
            "STORAGE_RECORD_INVALID"
        );
    }
}

#[test]
fn initial_selection_uses_os_cache_and_does_not_change_legacy_resolution() {
    let owned = tempfile::tempdir().unwrap();
    let selection = default_storage_location(owned.path(), &owned.path().join("OSCache")).unwrap();
    assert_eq!(selection.data_root, owned.path().join(".config/kcoder"));
    assert_eq!(
        selection.cache_root,
        owned.path().join(if cfg!(windows) {
            "OSCache/kcoder/cache"
        } else {
            "OSCache/kcoder"
        })
    );
    let legacy = resolve_storage_paths(&StorageResolveInput {
        home: Some(owned.path().to_owned()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(legacy.cache_root, owned.path().join(".config/kcoder/tmp"));
    assert!(std::fs::read_dir(owned.path()).unwrap().next().is_none());
}

#[cfg(windows)]
#[test]
fn windows_default_cache_is_below_nonempty_local_app_data_kcoder_parent() {
    let owned = tempfile::tempdir().unwrap();
    let local_app_data = owned.path().join("AppData/Local");
    let retained_parent = local_app_data.join("kcoder");
    for name in ["backups", "builds", "repairs", "tests"] {
        std::fs::create_dir_all(retained_parent.join(name)).unwrap();
        std::fs::write(
            retained_parent.join(name).join("retained.txt"),
            format!("original {name}"),
        )
        .unwrap();
    }

    let selection = default_storage_location(owned.path(), &local_app_data).unwrap();
    assert_eq!(selection.cache_root, retained_parent.join("cache"));
    assert!(crate::storage::inspect_storage_target(&selection.cache_root).is_ok());
    assert!(
        !selection.cache_root.exists(),
        "path calculation is read-only"
    );
    for name in ["backups", "builds", "repairs", "tests"] {
        assert_eq!(
            std::fs::read(retained_parent.join(name).join("retained.txt")).unwrap(),
            format!("original {name}").as_bytes()
        );
    }
}

#[test]
fn conflicting_windows_path_aliases_are_rejected_independently_of_map_order() {
    for name in super::OVERRIDE_NAMES {
        let mut input = StorageResolveInput::default();
        input.env.insert((*name).to_owned(), "first".into());
        input.env.insert(name.to_ascii_lowercase(), "second".into());
        assert_eq!(
            input.validate_environment(true).unwrap_err().to_string(),
            "STORAGE_ENV_CONFLICT"
        );
        input.validate_environment(false).unwrap();
        input.env.insert(name.to_ascii_lowercase(), "first".into());
        input.validate_environment(true).unwrap();
        input.env.insert((*name).to_owned(), OsString::new());
        assert_eq!(
            input.validate_environment(true).unwrap_err().to_string(),
            "STORAGE_ENV_CONFLICT"
        );
    }
}
