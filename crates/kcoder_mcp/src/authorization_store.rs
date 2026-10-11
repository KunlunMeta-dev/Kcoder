//! Private token persistence and cross-process credential leases.

use crate::authorization::{AuthorizationServerMetadata, validate_endpoint};
use crate::authorization_registration::RegisteredClient;
use crate::authorization_tokens::{
    ClientAuthentication, OAuthTokens, RefreshRecoveryRequired, TokenEndpointError,
};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const MAX_RECORD_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct CredentialBinding {
    pub resource: Url,
    pub issuer: Url,
    pub client_id: String,
    pub token_endpoint: Url,
}

pub struct OAuthTokenStore {
    pub(crate) directory: Arc<PrivateDirectory>,
}
pub struct OAuthCredentialLease {
    directory: Arc<PrivateDirectory>,
    lock: File,
    name: String,
    binding: CredentialBinding,
}

impl Drop for OAuthCredentialLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

fn is_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || error
            .raw_os_error()
            .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
}

fn is_missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

impl OAuthTokenStore {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            directory: Arc::new(PrivateDirectory::open_or_create(path)?),
        })
    }

    pub async fn acquire(&self, binding: CredentialBinding) -> Result<OAuthCredentialLease> {
        for url in [&binding.resource, &binding.issuer, &binding.token_endpoint] {
            validate_endpoint(url)?;
        }
        if binding.client_id.is_empty() || binding.issuer.query().is_some() {
            bail!("Invalid OAuth credential binding");
        }
        if binding.issuer.scheme() == "https" && binding.token_endpoint.scheme() != "https" {
            bail!("OAuth token endpoint must not downgrade HTTPS");
        }
        let key = serde_json::to_vec(&(
            binding.resource.as_str(),
            binding.issuer.as_str(),
            &binding.client_id,
        ))?;
        let name = format!("{:x}", Sha256::digest(key));
        let directory = Arc::clone(&self.directory);
        tokio::task::spawn_blocking(move || {
            let lock = acquire_lock(&directory, &name)?;
            Ok(OAuthCredentialLease {
                directory,
                lock,
                name: format!("{name}.json"),
                binding,
            })
        })
        .await
        .context("OAuth credential lease worker failed")?
    }
}

pub(crate) fn acquire_lock(directory: &PrivateDirectory, name: &str) -> Result<File> {
    let lock_name = format!("{name}.lock");
    let lock = match directory.open_read_write_file(OsStr::new(&lock_name), false) {
        Ok(file) => file,
        Err(error) if is_missing(&error) => {
            match directory.open_read_write_file(OsStr::new(&lock_name), true) {
                Ok(file) => file,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
                {
                    directory.open_read_write_file(OsStr::new(&lock_name), false)?
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(error) if is_contended(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Err(error) => {
                return Err(error).context("Cannot acquire OAuth credential lease");
            }
        }
    }
    Ok(lock)
}

pub struct OAuthRegistrationLease {
    directory: Arc<PrivateDirectory>,
    lock: File,
    name: String,
    metadata: AuthorizationServerMetadata,
    redirect: Url,
}
impl Drop for OAuthRegistrationLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

impl OAuthTokenStore {
    pub async fn acquire_registration(
        &self,
        metadata: &AuthorizationServerMetadata,
        redirect: &Url,
    ) -> Result<OAuthRegistrationLease> {
        let issuer =
            Url::parse(&metadata.issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        validate_endpoint(&issuer)?;
        validate_endpoint(redirect)?;
        if issuer.query().is_some() || redirect.query().is_some() {
            bail!("Invalid OAuth registration binding");
        }
        let key = serde_json::to_vec(&("registration", issuer.as_str(), redirect.as_str()))?;
        let name = format!("client-{:x}", Sha256::digest(key));
        let directory = Arc::clone(&self.directory);
        let metadata = metadata.clone();
        let redirect = redirect.clone();
        tokio::task::spawn_blocking(move || {
            let lock = acquire_lock(&directory, &name)?;
            Ok(OAuthRegistrationLease {
                directory,
                lock,
                name: format!("{name}.json"),
                metadata,
                redirect,
            })
        })
        .await
        .context("OAuth registration lease worker failed")?
    }
}

impl OAuthRegistrationLease {
    pub fn load(&self) -> Result<Option<RegisteredClient>> {
        let Some(bytes) = read_record(&self.directory, &self.name)? else {
            return Ok(None);
        };
        RegisteredClient::from_store_bytes(&bytes, &self.metadata, &self.redirect).map(Some)
    }
    pub fn save(&mut self, client: &RegisteredClient) -> Result<()> {
        let issuer = Url::parse(&self.metadata.issuer)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        if client.issuer() != &issuer || client.redirect_uri() != &self.redirect {
            bail!("OAuth client credential binding does not match");
        }
        let bytes = client.store_bytes()?;
        RegisteredClient::from_store_bytes(&bytes, &self.metadata, &self.redirect)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            bail!("OAuth client credential record exceeds the size limit");
        }
        self.directory
            .atomic_replace(OsStr::new(&self.name), &bytes)
    }
    pub fn remove(&mut self) -> Result<()> {
        match self.directory.remove_regular_file(OsStr::new(&self.name)) {
            Ok(()) => Ok(()),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn read_record(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_missing(&error) => return Ok(None),
        Err(error) => return Err(error).context("Cannot open OAuth credentials"),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("Cannot read OAuth credentials")?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        bail!("OAuth credential record exceeds the size limit");
    }
    Ok(Some(bytes))
}

impl OAuthCredentialLease {
    pub(crate) fn authorization_generation(&self) -> Result<String> {
        let Some(bytes) = read_record(&self.directory, &format!("{}.generation", self.name))?
        else {
            return Ok("initial".into());
        };
        if bytes.len() != 64 || !bytes.iter().all(u8::is_ascii_hexdigit) {
            bail!("Invalid OAuth authorization generation");
        }
        String::from_utf8(bytes.to_vec()).context("Invalid OAuth authorization generation")
    }

    pub(crate) fn invalidate_authorization(&mut self) -> Result<()> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("OAuth random source is unavailable"))?;
        let generation = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.directory.atomic_replace(
            OsStr::new(&format!("{}.generation", self.name)),
            generation.as_bytes(),
        )
    }

    pub fn load(&self) -> Result<Option<OAuthTokens>> {
        let Some(bytes) = read_record(&self.directory, &self.name)? else {
            return Ok(None);
        };
        OAuthTokens::from_store_bytes(
            &bytes,
            &self.binding.resource,
            &self.binding.issuer,
            &self.binding.client_id,
            &self.binding.token_endpoint,
        )
        .map(Some)
    }

    /// Persist a new authorization or a known refresh outcome; do not restore stale values after an uncertain refresh.
    pub fn save(&mut self, tokens: &OAuthTokens) -> Result<()> {
        self.write(tokens, false)
    }

    fn write(&self, tokens: &OAuthTokens, pending: bool) -> Result<()> {
        if tokens.resource() != &self.binding.resource
            || tokens.issuer() != &self.binding.issuer
            || tokens.client_id() != self.binding.client_id
            || tokens.token_endpoint() != &self.binding.token_endpoint
        {
            bail!("OAuth credential binding does not match");
        }
        let bytes = tokens.store_bytes_with_refresh_pending(pending)?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            bail!("OAuth credential record exceeds the size limit");
        }
        self.directory
            .atomic_replace(OsStr::new(&self.name), &bytes)
    }

    /// A pending bit and credentials are committed together, so a crash cannot silently reuse a spent refresh token.
    pub async fn refresh(&mut self, authentication: &ClientAuthentication) -> Result<()> {
        let mut tokens = self
            .load()?
            .ok_or_else(|| anyhow::anyhow!("OAuth credentials are unavailable"))?;
        if tokens.refresh_token().is_none() {
            bail!("OAuth refresh token is unavailable; authorization is required");
        }
        if matches!(authentication, ClientAuthentication::Basic(secret) | ClientAuthentication::Post(secret) if secret.is_empty())
        {
            bail!("OAuth client secret is required");
        }
        if let Err(error) = self.write(&tokens, true) {
            let _ = self.save(&tokens);
            return Err(error).context("Cannot persist OAuth refresh intent");
        }
        if let Err(error) = tokens.refresh(authentication).await {
            let rejected = error
                .downcast_ref::<TokenEndpointError>()
                .is_some_and(|failure| {
                    (400..500).contains(&failure.status())
                        && matches!(
                            failure.code(),
                            Some(
                                "invalid_client"
                                    | "invalid_request"
                                    | "invalid_scope"
                                    | "unauthorized_client"
                                    | "unsupported_grant_type"
                            )
                        )
                });
            if rejected {
                self.save(&tokens)
                    .context("Cannot finalize rejected OAuth refresh")?;
                return Err(error);
            }
            return Err(error.context(RefreshRecoveryRequired));
        }
        self.save(&tokens).context(RefreshRecoveryRequired)
    }

    pub fn remove(&mut self) -> Result<()> {
        match self.directory.remove_regular_file(OsStr::new(&self.name)) {
            Ok(()) => Ok(()),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> CredentialBinding {
        CredentialBinding {
            resource: Url::parse("https://resource.example.test/mcp").unwrap(),
            issuer: Url::parse("https://auth.example.test/").unwrap(),
            client_id: "client".into(),
            token_endpoint: Url::parse("https://auth.example.test/token").unwrap(),
        }
    }

    fn credentials(binding: &CredentialBinding) -> OAuthTokens {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version":1, "resource":binding.resource.as_str(), "issuer":binding.issuer.as_str(), "client_id":binding.client_id,
            "token_endpoint":binding.token_endpoint.as_str(), "access_token":"synthetic-access", "refresh_token":"synthetic-refresh", "expires_at_ms":1, "scope":"read"
        })).unwrap();
        OAuthTokens::from_store_bytes(
            &bytes,
            &binding.resource,
            &binding.issuer,
            &binding.client_id,
            &binding.token_endpoint,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn private_credentials_survive_reopen_without_reviving_expired_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("oauth");
        let store = OAuthTokenStore::open(&directory).unwrap();
        let mut lease = store.acquire(binding()).await.unwrap();
        assert!(lease.load().unwrap().is_none());
        lease.save(&credentials(&binding())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.join(&lease.name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(lease);
        let mut reopened = OAuthTokenStore::open(&directory)
            .unwrap()
            .acquire(binding())
            .await
            .unwrap();
        let tokens = reopened.load().unwrap().unwrap();
        assert_eq!(tokens.access_token(), "synthetic-access");
        assert_eq!(tokens.refresh_token(), Some("synthetic-refresh"));
        assert!(tokens.expires_at().unwrap() <= Instant::now());
        reopened.remove().unwrap();
        assert!(reopened.load().unwrap().is_none());
    }

    #[tokio::test]
    async fn malformed_and_rebound_credentials_fail_without_echoing_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(temp.path()).unwrap();
        let mut lease = store.acquire(binding()).await.unwrap();
        lease
            .directory
            .atomic_replace(
                OsStr::new(&lease.name),
                br#"{"access_token":"private-secret"}"#,
            )
            .unwrap();
        let error = lease.load().unwrap_err();
        assert!(!format!("{error:?}").contains("private-secret"));
        let mut other = binding();
        other.resource = Url::parse("https://other.example.test/mcp").unwrap();
        assert!(lease.save(&credentials(&other)).is_err());
        lease
            .directory
            .atomic_replace(
                OsStr::new(&lease.name),
                &credentials(&other).store_bytes().unwrap(),
            )
            .unwrap();
        assert!(lease.load().unwrap_err().to_string().contains("binding"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn credential_reads_reject_symlinks_and_writes_do_not_follow_them() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, "untouched").unwrap();
        let directory = temp.path().join("private");
        let store = OAuthTokenStore::open(&directory).unwrap();
        let mut lease = store.acquire(binding()).await.unwrap();
        std::os::unix::fs::symlink(&outside, directory.join(&lease.name)).unwrap();
        assert!(lease.load().is_err());
        lease.save(&credentials(&binding())).unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "untouched");
        assert!(lease.load().unwrap().is_some());
    }

    #[tokio::test]
    async fn unfinished_refresh_survives_reopen_and_new_authorization_recovers() {
        let temp = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(temp.path()).unwrap();
        let lease = store.acquire(binding()).await.unwrap();
        lease.write(&credentials(&binding()), true).unwrap();
        drop(lease);
        let mut reopened = OAuthTokenStore::open(temp.path())
            .unwrap()
            .acquire(binding())
            .await
            .unwrap();
        assert!(reopened.load().unwrap_err().is::<RefreshRecoveryRequired>());
        assert!(
            reopened
                .refresh(&ClientAuthentication::Public)
                .await
                .unwrap_err()
                .is::<RefreshRecoveryRequired>()
        );
        reopened.save(&credentials(&binding())).unwrap();
        assert!(reopened.load().unwrap().is_some());
    }

    #[tokio::test]
    async fn refresh_intent_is_durable_before_network_and_commits_atomically() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, uncertain) in [
            (
                200,
                r#"{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600}"#,
                false,
            ),
            (
                400,
                r#"{"error":"invalid_client","error_description":"private-secret"}"#,
                false,
            ),
            (
                503,
                r#"{"error":"temporarily_unavailable","error_description":"private-secret"}"#,
                true,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let mut target = binding();
            target.issuer = Url::parse(&origin).unwrap();
            target.token_endpoint = Url::parse(&format!("{origin}/token")).unwrap();
            let temp = tempfile::tempdir().unwrap();
            let store = OAuthTokenStore::open(temp.path()).unwrap();
            let mut lease = store.acquire(target.clone()).await.unwrap();
            lease.save(&credentials(&target)).unwrap();
            let record = temp.path().join(&lease.name);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0u8; 4096];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let persisted: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
                assert_eq!(persisted["refresh_pending"], true);
                assert_eq!(persisted["version"], 2);
                let response = format!(
                    "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result = lease.refresh(&ClientAuthentication::Public).await;
            if status == 200 {
                result.unwrap();
            } else {
                let error = result.unwrap_err();
                assert!(!format!("{error:?}").contains("private-secret"));
                assert_eq!(error.is::<RefreshRecoveryRequired>(), uncertain);
            }
            server.await.unwrap();
            drop(lease);
            let reopened = OAuthTokenStore::open(temp.path())
                .unwrap()
                .acquire(target)
                .await
                .unwrap();
            if uncertain {
                assert!(reopened.load().unwrap_err().is::<RefreshRecoveryRequired>());
            } else {
                let tokens = reopened.load().unwrap().unwrap();
                assert_eq!(
                    tokens.access_token(),
                    if status == 200 {
                        "new-access"
                    } else {
                        "synthetic-access"
                    }
                );
                assert_eq!(
                    tokens.refresh_token(),
                    Some(if status == 200 {
                        "new-refresh"
                    } else {
                        "synthetic-refresh"
                    })
                );
            }
        }
    }

    fn registration_metadata() -> AuthorizationServerMetadata {
        serde_json::from_value(serde_json::json!({
            "issuer":"https://auth.example.test", "authorization_endpoint":"https://auth.example.test/authorize", "token_endpoint":"https://auth.example.test/token",
            "response_types_supported":["code"], "code_challenge_methods_supported":["S256"], "token_endpoint_auth_methods_supported":["client_secret_post"]
        })).unwrap()
    }

    #[tokio::test]
    async fn registered_clients_restore_private_credentials_and_expiry() {
        use crate::authorization_registration::RegistrationMethod;
        let temp = tempfile::tempdir().unwrap();
        let metadata = registration_metadata();
        let redirect = Url::parse("http://127.0.0.1/callback").unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "cached-client".into(),
            Some(Zeroizing::new("registration-secret".into())),
            RegistrationMethod::Post,
            &redirect,
        )
        .unwrap();
        let store = OAuthTokenStore::open(temp.path()).unwrap();
        let mut lease = store
            .acquire_registration(&metadata, &redirect)
            .await
            .unwrap();
        assert!(lease.load().unwrap().is_none());
        lease.save(&client).unwrap();
        drop(lease);
        let mut lease = OAuthTokenStore::open(temp.path())
            .unwrap()
            .acquire_registration(&metadata, &redirect)
            .await
            .unwrap();
        let restored = lease.load().unwrap().unwrap();
        assert_eq!(restored.client_id(), "cached-client");
        match restored.authentication().unwrap() {
            ClientAuthentication::Post(secret) => {
                assert_eq!(secret.as_str(), "registration-secret")
            }
            _ => panic!("wrong authentication method"),
        }
        assert!(!format!("{restored:?}").contains("registration-secret"));
        let mut expired: serde_json::Value =
            serde_json::from_slice(&client.store_bytes().unwrap()).unwrap();
        expired["expires"] = serde_json::json!(1);
        lease
            .directory
            .atomic_replace(
                OsStr::new(&lease.name),
                &serde_json::to_vec(&expired).unwrap(),
            )
            .unwrap();
        assert!(lease.load().unwrap().unwrap().authentication().is_err());
        lease.remove().unwrap();
        assert!(lease.load().unwrap().is_none());
    }

    #[tokio::test]
    async fn registered_client_binding_and_corruption_are_not_silent_cache_misses() {
        use crate::authorization_registration::RegistrationMethod;
        let temp = tempfile::tempdir().unwrap();
        let metadata = registration_metadata();
        let redirect = Url::parse("http://127.0.0.1/callback").unwrap();
        let client = RegisteredClient::manual(
            &metadata,
            "cached-client".into(),
            Some(Zeroizing::new("registration-secret".into())),
            RegistrationMethod::Post,
            &Url::parse("http://127.0.0.1/other").unwrap(),
        )
        .unwrap();
        let store = OAuthTokenStore::open(temp.path()).unwrap();
        let mut lease = store
            .acquire_registration(&metadata, &redirect)
            .await
            .unwrap();
        assert!(lease.save(&client).is_err());
        lease
            .directory
            .atomic_replace(OsStr::new(&lease.name), &client.store_bytes().unwrap())
            .unwrap();
        assert!(lease.load().unwrap_err().to_string().contains("binding"));
        lease
            .directory
            .atomic_replace(
                OsStr::new(&lease.name),
                br#"{"secret":"registration-secret"}"#,
            )
            .unwrap();
        assert!(!format!("{:?}", lease.load().unwrap_err()).contains("registration-secret"));
    }

    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }

    #[tokio::test]
    async fn leases_serialize_mutations_across_processes() {
        let temp = tempfile::tempdir().unwrap();
        let store = OAuthTokenStore::open(temp.path()).unwrap();
        let mut lease = store.acquire(binding()).await.unwrap();
        lease.save(&credentials(&binding())).unwrap();
        let lock_name = lease.name.replace(".json", ".lock");
        let mut child = ChildGuard(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "authorization_store::tests::lease_child_probe",
                    "--ignored",
                ])
                .env("KCODER_OAUTH_LEASE_PROBE", temp.path())
                .env("KCODER_OAUTH_LEASE_LOCK", lock_name)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !temp.path().join("blocked").exists() {
            assert!(
                Instant::now() < deadline,
                "child did not observe the held lease"
            );
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child failed before contention proof"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(child.0.try_wait().unwrap().is_none());
        drop(lease);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "child did not acquire the released lease"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            store
                .acquire(binding())
                .await
                .unwrap()
                .load()
                .unwrap()
                .is_none()
        );
    }

    #[test]
    #[ignore = "subprocess entry exercised by leases_serialize_mutations_across_processes"]
    fn lease_child_probe() {
        let path = std::env::var_os("KCODER_OAUTH_LEASE_PROBE").expect("owned probe directory");
        let store = OAuthTokenStore::open(Path::new(&path)).unwrap();
        let name = std::env::var_os("KCODER_OAUTH_LEASE_LOCK").unwrap();
        let file = store.directory.open_read_write_file(&name, false).unwrap();
        assert!(is_contended(&file.try_lock_exclusive().unwrap_err()));
        std::fs::write(Path::new(&path).join("blocked"), "blocked").unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut lease = store.acquire(binding()).await.unwrap();
                assert!(lease.load().unwrap().is_some());
                lease.remove().unwrap();
            });
    }
}
