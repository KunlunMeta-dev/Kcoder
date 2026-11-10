use super::*;
use crate::BrowserRegistry;
use kcoder_app_protocol::{BrowserEvaluateParams, BrowserSessionParams, BrowserStartParams};
use kcoder_native_scope::NativeDomain;
use kcoder_types::browser_profiles::{BrowserAccountProfileDraft, BrowserProfilePurpose};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn params(
    native: &NativeIntegrationContext,
    id: &str,
    operation: &str,
    url: &str,
) -> BrowserStartParams {
    BrowserStartParams {
        url: url.into(),
        width: 680,
        height: 480,
        profile: Some(BrowserProfileSelection {
            scope: native.scope().clone(),
            profile_id: id.into(),
            expected_revision: 1,
            operation_id: operation.into(),
        }),
    }
}
async fn cookie(registry: &mut BrowserRegistry, session: &str, expression: &str) -> Value {
    registry
        .evaluate(BrowserEvaluateParams {
            session_id: session.into(),
            expression: expression.into(),
        })
        .await
        .unwrap()
        .value
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires explicitly supplied Chromium and owned loopback fixture; no model or external site"]
async fn actual_chromium_profiles_keep_cookie_identity_exclusive_reconcile_start_and_release_owned_tree()
-> Result<()> {
    ensure!(
        std::env::var_os("KCODER_CHROMIUM_BIN").is_some(),
        "explicit installed Chromium required"
    );
    // The owned fixture parent is not another application profile. Keep the
    // actual native profile private without adding a dated managed-temp layer.
    let root = tempfile::Builder::new().prefix("bp-").tempdir()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    #[cfg(windows)]
    let default_profile =
        std::env::var("KCODER_TEST_BROWSER_DEFAULT_PROFILE").as_deref() == Ok("1");
    #[cfg(not(windows))]
    let default_profile = false;
    let profile_path = if default_profile {
        ensure!(
            std::env::var_os("KCODER_CONFIG_DIR").is_none(),
            "default profile cannot have a configuration override"
        );
        let path = kcoder_config::Settings::config_dir()?;
        // Test harnesses resolve a fresh private profile; it must still be empty.
        ensure!(
            std::fs::read_dir(&path).map_or(true, |mut entries| entries.next().is_none()),
            "default profile fixture must be new"
        );
        PrivateDirectory::open_or_create(&path)?;
        path
    } else {
        parent.create_private_child(OsStr::new("profile"))?;
        root.path().join("profile")
    };
    parent.create_private_child(OsStr::new("workspace"))?;
    let native = NativeIntegrationContext::capture(
        &profile_path,
        &root.path().join("workspace"),
        "actual-browser",
        "revision",
    )?;
    let (_, store) = NativeDomainGuard::initialize(
        native.profile()?,
        native.scope(),
        NativeDomain::BrowserProfiles,
        "create-browser-catalog",
        |directory| {
            BrowserProfileStore::create_in(directory, OsStr::new("catalog"), native.scope())
        },
    )?;
    for id in ["personal", "business"] {
        store.save(
            &format!("create-{id}"),
            BrowserAccountProfileDraft {
                id: id.into(),
                label: id.into(),
                account_label: Some("User label only".into()),
                purpose: BrowserProfilePurpose::Business,
            },
            0,
        )?;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let cancelled = tokio_util::sync::CancellationToken::new();
    let shutdown = cancelled.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let accepted = tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = connections.join_next(), if !connections.is_empty() => continue,
                result = listener.accept() => result.unwrap()
            };
            connections.spawn(async move {
                let (mut socket, _) = accepted;
                let mut bytes = [0u8;8192];
                let received = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    let mut count = 0;
                    while count < bytes.len() {
                        let length = socket.read(&mut bytes[count..]).await?;
                        if length == 0 { return Ok::<_,std::io::Error>(false); }
                        count += length;
                        if bytes[..count].windows(4).any(|value| value == b"\r\n\r\n") { return Ok(true); }
                    }
                    Ok(false)
                }).await;
                if !matches!(received, Ok(Ok(true))) { return; }
                let body = "<!doctype html><title>Owned profile fixture</title><p>Independent browser accounts</p>";
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    });
    assert_eq!(
        reqwest::Client::builder()
            .no_proxy()
            .build()?
            .get(&url)
            .send()
            .await?
            .status(),
        reqwest::StatusCode::OK
    );
    let mut first = BrowserRegistry::new();
    let mut second = BrowserRegistry::new();
    let baseline = first
        .start(
            "actual-temporary",
            BrowserStartParams {
                url: url.clone(),
                width: 680,
                height: 480,
                profile: None,
            },
            None,
        )
        .await
        .context("actual temporary browser baseline")?;
    first
        .close(BrowserSessionParams {
            session_id: baseline.session_id,
        })
        .await?;
    let personal = first
        .start(
            "actual-personal",
            params(&native, "personal", "start-personal", &url),
            Some(&native),
        )
        .await
        .context("actual personal profile start")?;
    let owned_profile = first.sessions[&personal.session_id]
        .process
        .profile_binding
        .as_ref()
        .context("original profile binding missing")?;
    println!(
        "{}",
        json!({"actualNativeBrowserProfileFixture":{"defaultProductionProfile":default_profile,"profilePathChars":profile_path.to_string_lossy().chars().count(),"userDataPathChars":owned_profile.path().to_string_lossy().chars().count(),"chromiumDefaultKeyPolicy":true,"passwordStoreOverride":false,"modelCalls":0}})
    );
    assert_eq!(
        cookie(
            &mut first,
            &personal.session_id,
            "document.cookie='account=personal; Max-Age=3600; Path=/'; document.cookie"
        )
        .await,
        json!("account=personal")
    );
    let replay = first
        .start(
            "actual-personal",
            params(&native, "personal", "start-personal", &url),
            Some(&native),
        )
        .await?;
    assert_eq!(replay.session_id, personal.session_id);
    assert_eq!(first.resource_count(), 1);
    assert!(
        second
            .start(
                "foreign-claim",
                params(&native, "personal", "competing-personal", &url),
                Some(&native)
            )
            .await
            .is_err()
    );
    let business = second
        .start(
            "actual-business",
            params(&native, "business", "start-business", &url),
            Some(&native),
        )
        .await?;
    let human = first
        .handoff(
            kcoder_app_protocol::browser_profiles::BrowserHandoffParams {
                session_id: personal.session_id.clone(),
                expected_revision: 1,
                mode: kcoder_app_protocol::browser_profiles::BrowserControlMode::Human,
            },
        )
        .await?;
    assert_eq!(human.revision, 2);
    assert!(
        first
            .evaluate(BrowserEvaluateParams {
                session_id: personal.session_id.clone(),
                expression: "document.title".into()
            })
            .await
            .is_err()
    );
    first
        .human_action(
            kcoder_app_protocol::browser_profiles::BrowserHumanActionParams {
                expected_revision: human.revision,
                action: kcoder_app_protocol::BrowserActionParams {
                    session_id: personal.session_id.clone(),
                    action: kcoder_app_protocol::BrowserAction::Text {
                        text: "human-controlled".into(),
                    },
                },
            },
        )
        .await?;
    let returned = first
        .handoff(
            kcoder_app_protocol::browser_profiles::BrowserHandoffParams {
                session_id: personal.session_id.clone(),
                expected_revision: human.revision,
                mode: kcoder_app_protocol::browser_profiles::BrowserControlMode::Automation,
            },
        )
        .await?;
    assert_eq!(returned.revision, 3);
    assert_eq!(returned.observed_url, url);
    assert!(
        first
            .handoff(
                kcoder_app_protocol::browser_profiles::BrowserHandoffParams {
                    session_id: personal.session_id.clone(),
                    expected_revision: human.revision,
                    mode: kcoder_app_protocol::browser_profiles::BrowserControlMode::Human,
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        cookie(&mut second, &business.session_id, "document.cookie").await,
        json!("")
    );
    assert_eq!(
        cookie(
            &mut second,
            &business.session_id,
            "document.cookie='account=business; Max-Age=3600; Path=/'; document.cookie"
        )
        .await,
        json!("account=business")
    );
    assert!(
        first
            .close(BrowserSessionParams {
                session_id: personal.session_id.clone()
            })
            .await?
            .closed
    );
    assert!(
        first
            .start(
                "actual-personal",
                params(&native, "personal", "start-personal", &url),
                Some(&native)
            )
            .await
            .is_err()
    );
    let reopened = first
        .start(
            "actual-personal",
            params(&native, "personal", "reopen-personal", &url),
            Some(&native),
        )
        .await?;
    assert_eq!(
        cookie(&mut first, &reopened.session_id, "document.cookie").await,
        json!("account=personal")
    );
    assert_eq!(
        cookie(&mut second, &business.session_id, "document.cookie").await,
        json!("account=business")
    );
    first.shutdown_all().await;
    second.shutdown_all().await;
    assert_eq!(first.resource_count() + second.resource_count(), 0);
    let guard = NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::BrowserProfiles,
    )?
    .unwrap();
    let directory = native
        .profile_path()?
        .join(guard.namespace_id())
        .join("catalog");
    let receipts = std::fs::read_dir(directory)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("cleanup-"))
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 3);
    for receipt in receipts {
        assert_eq!(
            std::fs::read(receipt.path())?,
            b"kcoder-owned-cleanup/v1\nconfirmed\n"
        );
    }
    for id in ["personal", "business"] {
        let usage = store.begin_use(id, 1)?;
        store.finish_use_after_owned_cleanup(&usage)?;
    }
    cancelled.cancel();
    server.await?;
    Ok(())
}
