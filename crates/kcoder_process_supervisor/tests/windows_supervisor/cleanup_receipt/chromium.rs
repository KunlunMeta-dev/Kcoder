use super::*;

#[test]
#[ignore = "Requires explicit owned Chromium; diagnostic launch representation pair, no model"]
fn actual_chromium_receipt_owner_observes_normal_and_verbatim_user_data_arguments() {
    let chromium = PathBuf::from(std::env::var_os("KCODER_CHROMIUM_BIN").unwrap());
    let root = tempfile::tempdir().unwrap();
    let mut observations = Vec::new();
    for label in [
        "normal",
        "verbatim",
        "private",
        "private-nested",
        "private-deep",
        "private-deep-verbatim",
    ] {
        let profile = if label.starts_with("private-") {
            let base = if label.starts_with("private-deep") {
                root.path()
                    .join("deep-config-directory-additional-forty-xxx")
            } else {
                root.path().to_owned()
            };
            base.join("browser-profile-real-chromium-123456")
                .join("profile")
                .join(format!("integration-{}", "a".repeat(64)))
                .join("catalog")
                .join("browser-data-personal")
        } else {
            root.path().join(label)
        };
        std::fs::create_dir_all(&profile).unwrap();
        if label.starts_with("private") {
            let literal = profile.to_string_lossy().replace('\'', "''");
            let script = format!(
                "$p='{literal}';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $p -AclObject $acl"
            );
            assert!(
                Command::new(powershell())
                    .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let user_data = if label.ends_with("verbatim") {
            profile.canonicalize().unwrap()
        } else {
            profile
        };
        let mut file = private_receipt(&root.path().join(format!("receipt-{label}")));
        let mut child = SupervisedChild::spawn_with_cleanup_receipt(
            SpawnSpec {
                executable: chromium.clone(),
                cwd: root.path().to_owned(),
                args: [
                    "--headless=new".to_owned(),
                    "--disable-dev-shm-usage".to_owned(),
                    "--disable-gpu".to_owned(),
                    "--no-proxy-server".to_owned(),
                    "--remote-debugging-port=0".to_owned(),
                    format!("--user-data-dir={}", user_data.display()),
                    "about:blank".to_owned(),
                ]
                .into_iter()
                .map(Into::into)
                .collect(),
                env: explicit_environment(),
            },
            &file,
            &supervisor(),
        )
        .unwrap();
        let stderr = child.take_stderr().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut ready = false;
        let mut lines = Vec::new();
        while Instant::now() < deadline {
            let Ok(line) = receiver.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            if line.contains("DevTools listening on ") {
                ready = true;
                break;
            }
            if lines.len() < 8 {
                lines.push(line.chars().take(512).collect::<String>());
            }
        }
        let mut kill_error = None;
        let status = if let Some(status) = child.try_wait().unwrap() {
            Some(status)
        } else {
            // Natural exit can race a requested stop; still join the original helper.
            kill_error = child.kill().err().map(|error| error.to_string());
            child.wait_with_timeout(Duration::from_secs(10)).unwrap()
        };
        drop(receiver);
        reader.join().unwrap();
        assert_eq!(receipt_bytes(&mut file), CONFIRMED);
        let observation = json!({"representation":label,"userDataChars":user_data.as_os_str().len(),"devtoolsReady":ready,"cleanupConfirmed":true,"exitCode":status.and_then(|status|status.code()),"killError":kill_error,"stderr":lines});
        println!("{}", json!({"actualChromiumLaunchObservation":observation}));
        observations.push(observation);
    }
    println!("{}", json!({"actualChromiumLaunchPair":observations}));
    assert_eq!(observations[0]["devtoolsReady"], true);
}
