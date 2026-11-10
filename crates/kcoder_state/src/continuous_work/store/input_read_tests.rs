use super::*;
use serde_json::json;

fn fixture() -> Result<(
    kcoder_config::PrivateTempDir,
    ContinuousWorkStore,
    WorkScope,
    WorkInputSource,
)> {
    let temp = kcoder_config::create_private_temp_dir("continuous-single-read")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let scope = WorkScope {
        account_id: "a".into(),
        target_id: "t".into(),
        workspace_id: "w".into(),
    };
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "target-thread".into(),
        conversation_id: "thread".into(),
    };
    let work: WorkRecord = serde_json::from_value(
        json!({"schemaVersion":1,"identity":{"scope":scope,"workId":"work"},
            "origin":{"kind":"foreground","initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"}},
            "linkedThreadIds":["thread"],"phase":"pending","revision":{"revision":1,"requirementsRevision":1,
                "controlEpoch":0,"ownerEpoch":0,"acceptedInputSequence":1,"requiredInputSequence":1,"appliedInputSequence":0}}),
    )?;
    store.admit(
        &scope,
        work,
        &source,
        "first",
        json!({"text":"original body"}),
        vec![],
    )?;
    Ok((temp, store, scope, source))
}

#[test]
fn single_body_read_does_not_hold_state_lock_against_stop() -> Result<()> {
    let (_temp, store, scope, source) = fixture()?;
    let observed = store
        .read_input_inner(&scope, "work", &source, "first", || {
            store.control(
                &scope,
                "work",
                1,
                "stop",
                WorkControlAction::Stop,
                WorkControlTarget::Work {},
            )?;
            Ok(())
        })?
        .unwrap();
    assert_eq!(observed.1, json!({"text":"original body"}));
    assert_eq!(
        store.current_control(&scope, "work")?.unwrap().action,
        WorkControlAction::Stop
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn same_name_and_same_bytes_replacement_during_single_read_is_rejected() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let (temp, store, scope, source) = fixture()?;
    let receipt = store
        .read_input(&scope, "work", &source, "first")?
        .unwrap()
        .0;
    let directory = temp.path().join("continuous-work.v1");
    let path = directory.join(&receipt.payload_ref);
    let original = std::fs::read(&path)?;
    let state = directory.join("state.json");
    let before = std::fs::read(&state)?;
    let result = store.read_input_inner(&scope, "work", &source, "first", || {
        std::fs::rename(&path, directory.join("original-held"))?;
        std::fs::write(&path, &original)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(&state)?, before);
    assert_eq!(std::fs::read(directory.join("original-held"))?, original);
    Ok(())
}

#[cfg(windows)]
#[test]
fn windows_single_read_rejects_replacement_or_observes_os_denial() -> Result<()> {
    let (temp, store, scope, source) = fixture()?;
    let receipt = store
        .read_input(&scope, "work", &source, "first")?
        .unwrap()
        .0;
    let directory = temp.path().join("continuous-work.v1");
    let path = directory.join(&receipt.payload_ref);
    let saved = directory.join("original-held");
    let original = std::fs::read(&path)?;
    let state_path = directory.join("state.json");
    let before = std::fs::read(&state_path)?;
    let mut replaced = false;
    let result = store.read_input_inner(&scope, "work", &source, "first", || {
        match std::fs::rename(&path, &saved) {
            Ok(()) => {
                std::fs::write(&path, &original)?;
                replaced = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    });
    if replaced {
        assert!(result.is_err());
        assert_eq!(std::fs::read(saved)?, original);
    } else {
        assert_eq!(result?.unwrap().1, json!({"text":"original body"}));
        assert_eq!(std::fs::read(&path)?, original);
        assert!(!saved.exists());
    }
    assert_eq!(std::fs::read(state_path)?, before);
    Ok(())
}
