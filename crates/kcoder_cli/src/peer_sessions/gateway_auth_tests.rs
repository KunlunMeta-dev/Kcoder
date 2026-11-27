use super::*;
use serde_json::{Value, json};
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct HttpFixture {
    url: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl HttpFixture {
    async fn start(drop_first_refresh: bool) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let task = tokio::spawn(async move {
            let mut refreshes = 0;
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut bytes = Vec::new();
                let mut scratch = [0; 4096];
                let header_end = loop {
                    let count = socket.read(&mut scratch).await.unwrap_or(0);
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&scratch[..count]);
                    assert!(bytes.len() <= 65536);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]);
                let path = header.split_whitespace().nth(1).unwrap().to_owned();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(length < 32768);
                while bytes.len() < header_end + length {
                    let count = socket.read(&mut scratch).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&scratch[..count]);
                }
                let body: Value = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
                };
                observed.lock().unwrap().push((path.clone(), body));
                let refresh = path.ends_with("/refresh");
                if refresh {
                    refreshes += 1;
                    if refreshes == 1 && drop_first_refresh {
                        continue;
                    }
                }
                let suffix = if refresh { "rotated" } else { "initial" };
                let body=json!({"deviceId":"owned-device","authorizationGeneration":"owned-family",
                    "accessToken":format!("owned-access-{suffix}"),"refreshToken":format!("owned-refresh-{suffix}"),
                    "rpcToken":"owned-rpc","expiresAt":4102444800000u64}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Ok(Self {
            url,
            requests,
            task,
        })
    }
}

#[test]
fn credential_origin_allows_http_and_rejects_embedded_authority() -> Result<()> {
    assert!(canonical("https://user:secret@example.com", false).is_err());
    assert!(canonical("https://example.com/?token=secret", false).is_err());
    assert!(canonical("http://192.0.2.1", false).is_ok());
    assert!(canonical("http://192.0.2.1", true).is_ok());
    assert!(canonical("http://127.0.0.1:1234", false).is_ok());
    assert!(canonical("ftp://example.com", true).is_err());
    Ok(())
}

#[tokio::test]
async fn actual_http_pair_is_not_replayed_and_refresh_reuses_the_original_rotation_after_loss()
-> Result<()> {
    let server = HttpFixture::start(true).await?;
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let mut client = GatewayDeviceClient::pair(
        root.path(),
        &server.url,
        "owned-pair-code",
        CredentialStoreMode::File,
        false,
    )
    .await?;
    assert!(
        GatewayDeviceClient::pair(
            root.path(),
            &server.url,
            "second-pair-code",
            CredentialStoreMode::File,
            false
        )
        .await
        .is_err()
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "existing enrollment must reject before another HTTP mutation"
    );
    let metadata_before = std::fs::read(root.path().join(STORE))?;
    assert!(
        !client.refresh_if_due().await?,
        "fresh shared credentials do not rotate on the maintenance path"
    );
    assert_eq!(
        metadata_before,
        std::fs::read(root.path().join(STORE))?,
        "warm maintenance does not rewrite metadata"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "warm maintenance does not contact the Gateway"
    );
    assert!(client.refresh().await.is_err());
    let resumed = GatewayDeviceClient::load(root.path(), false)?;
    assert!(resumed.stored.pending_rotation_id.is_some());
    client.refresh().await?;
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[1].1.get("rotationId"),
        requests[2].1.get("rotationId")
    );
    assert_eq!(
        requests[1].1.get("refreshToken"),
        requests[2].1.get("refreshToken")
    );
    drop(requests);
    let resumed = GatewayDeviceClient::load(root.path(), false)?;
    assert_eq!(resumed.secret.access_token, "owned-access-rotated");
    assert!(resumed.stored.pending_rotation_id.is_none());
    let summary = serde_json::to_string(&resumed.summary())?;
    for secret in [
        "owned-access",
        "owned-refresh",
        "owned-rpc",
        "owned-pair-code",
    ] {
        assert!(!summary.contains(secret));
    }
    Ok(())
}

#[test]
fn renewal_uses_the_actual_gateway_clock_and_the_original_receipts_remaining_lifetime() -> Result<()>
{
    let local = now_ms();
    let gateway = local + 7 * 24 * 60 * 60 * 1000;
    let body = |expiry| {
        json!({"deviceId":"clock-device","authorizationGeneration":"clock-family",
        "accessToken":"owned-clock-access","refreshToken":"owned-clock-refresh","rpcToken":"owned-clock-rpc",
        "expiresAt":expiry,"accessTtlMs":3000})
    };
    let current = device(
        &DeviceReply {
            body: body(gateway + 3000),
            server_now_ms: Some(gateway),
        },
        None,
        "https://owned.invalid/",
    )?;
    assert!(
        current.refresh_at_ms >= local + 1500 && current.refresh_at_ms <= now_ms() + 2500,
        "a different host clock cannot stretch a short credential into days"
    );
    let old = device(
        &DeviceReply {
            body: body(gateway - 1000),
            server_now_ms: Some(gateway),
        },
        None,
        "https://owned.invalid/",
    )?;
    assert!(
        old.refresh_at_ms <= now_ms(),
        "a reconciled expired rotation receipt must not restart its original full TTL"
    );
    Ok(())
}

#[tokio::test]
async fn profile_copy_cannot_borrow_another_profiles_credential_pointer() -> Result<()> {
    let server = HttpFixture::start(false).await?;
    let original = tempfile::tempdir()?;
    let other = tempfile::tempdir()?;
    let original_dir = PrivateDirectory::open_or_create(original.path())?;
    let other_dir = PrivateDirectory::open_or_create(other.path())?;
    GatewayDeviceClient::pair(
        original.path(),
        &server.url,
        "owned-pair-code",
        CredentialStoreMode::File,
        false,
    )
    .await?;
    use std::io::Read;
    let mut bytes = Vec::new();
    original_dir
        .open_single_link_regular_file(OsStr::new(STORE))?
        .read_to_end(&mut bytes)?;
    other_dir.atomic_replace(OsStr::new(STORE), &bytes)?;
    assert!(GatewayDeviceClient::load(other.path(), false).is_err());
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "scope failure never contacts the original Gateway"
    );
    Ok(())
}

#[tokio::test]
async fn a_live_client_never_refreshes_replaced_enrollment_credentials_against_its_old_gateway()
-> Result<()> {
    let first = HttpFixture::start(false).await?;
    let second = HttpFixture::start(false).await?;
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let mut old = GatewayDeviceClient::pair(
        root.path(),
        &first.url,
        "owned-first-code",
        CredentialStoreMode::File,
        false,
    )
    .await?;
    GatewayDeviceClient::forget(root.path())?;
    GatewayDeviceClient::pair(
        root.path(),
        &second.url,
        "owned-second-code",
        CredentialStoreMode::File,
        false,
    )
    .await?;
    let current = std::fs::read(root.path().join(STORE))?;
    assert!(
        old.refresh()
            .await
            .unwrap_err()
            .is::<DeviceEnrollmentChanged>()
    );
    assert_eq!(std::fs::read(root.path().join(STORE))?, current);
    assert_eq!(
        first.requests.lock().unwrap().len(),
        1,
        "the old endpoint never receives the new endpoint's refresh token"
    );
    assert_eq!(
        second.requests.lock().unwrap().len(),
        1,
        "the old runtime never silently switches its original endpoint"
    );
    Ok(())
}

#[tokio::test]
async fn credential_mutation_waits_for_real_owner_without_dispatching_before_unlock() -> Result<()>
{
    let server = HttpFixture::start(false).await?;
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_or_create(root.path())?;
    let mut client = GatewayDeviceClient::pair(
        root.path(),
        &server.url,
        "owned-code",
        CredentialStoreMode::File,
        false,
    )
    .await?;
    let lock = profile
        .try_exclusive_lock(OsStr::new(LOCK))?
        .context("real competing lock")?;
    let observed = server.requests.clone();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            observed.lock().unwrap().len(),
            1,
            "HTTP mutation cannot start under another owner"
        );
        drop(lock);
    });
    client.refresh().await?;
    release.await?;
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    Ok(())
}
