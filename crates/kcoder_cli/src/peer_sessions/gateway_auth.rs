//! Actual Gateway device enrollment. Secrets stay outside Engine/model state.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStoreMode, OsCredentialBackend, PrivateDirectory,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, path::Path, sync::Arc, time::Duration};

const STORE: &str = "peer-gateway-session.json";
const PENDING_PAIR: &str = "peer-gateway-pair-pending.json";
const LOCK: &str = "peer-gateway-credentials.lock";
const MAX_REPLY: usize = 64 * 1024;
fn zero(value: &u64) -> bool {
    *value == 0
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
#[derive(Debug)]
pub(super) struct DeviceAuthorizationRejected;
impl std::fmt::Display for DeviceAuthorizationRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("peer Gateway device authorization rejected")
    }
}
impl std::error::Error for DeviceAuthorizationRejected {}
#[derive(Debug)]
pub(super) struct DeviceEnrollmentChanged;
impl std::fmt::Display for DeviceEnrollmentChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("peer Gateway enrollment changed")
    }
}
impl std::error::Error for DeviceEnrollmentChanged {}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDevice {
    gateway: String,
    backend: CredentialStoreMode,
    credential_key: String,
    #[serde(default)]
    secret: Option<DeviceSecret>,
    #[serde(default)]
    pending_rotation_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeviceSecret {
    pub gateway: String,
    pub device_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub rpc_token: String,
    pub authorization_generation: String,
    pub expires_at: u64,
    // Local maintenance time, never an authorization verdict. Old credentials
    // omit it and retain their original immutable credential-key serialization.
    #[serde(default, skip_serializing_if = "zero")]
    refresh_at_ms: u64,
}
/// No Debug implementation: HTTP credentials never become diagnostics/context.
pub(super) struct GatewayDeviceClient {
    http: reqwest::Client,
    base: reqwest::Url,
    profile: PrivateDirectory,
    backend: Arc<dyn CredentialBackend>,
    stored: StoredDevice,
    secret: DeviceSecret,
    allow_insecure: bool,
}
fn canonical(url: &str, _allow_insecure: bool) -> Result<reqwest::Url> {
    let mut parsed = reqwest::Url::parse(url).context("invalid peer Gateway URL")?;
    ensure!(
        parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "peer Gateway URL cannot contain credentials/query/fragment"
    );
    ensure!(
        parsed.scheme() == "https" || parsed.scheme() == "http",
        "peer Gateway URL must use HTTP or HTTPS"
    );
    if !parsed.path().ends_with('/') {
        parsed.set_path(&format!("{}/", parsed.path()));
    }
    Ok(parsed)
}
struct DeviceReply {
    body: serde_json::Value,
    server_now_ms: Option<u64>,
}
async fn reply(response: reqwest::Response) -> Result<DeviceReply> {
    let server_now_ms = response
        .headers()
        .get(reqwest::header::DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok());
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(DeviceAuthorizationRejected.into());
    }
    ensure!(
        response.status().is_success(),
        "peer Gateway rejected the device request"
    );
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("peer Gateway response unconfirmed")?
    {
        ensure!(
            bytes.len() + chunk.len() <= MAX_REPLY,
            "peer Gateway response exceeds bound"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(DeviceReply {
        body: serde_json::from_slice(&bytes).context("peer Gateway response is invalid")?,
        server_now_ms,
    })
}
fn device(
    reply: &DeviceReply,
    prior: Option<&DeviceSecret>,
    gateway: &str,
) -> Result<DeviceSecret> {
    let value = &reply.body;
    let text = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                !value.is_empty() && value.len() <= 8192 && !value.chars().any(char::is_control)
            })
            .map(str::to_owned)
            .with_context(|| format!("peer Gateway response omitted {name}"))
    };
    let expires_at = value
        .get("expiresAt")
        .and_then(serde_json::Value::as_u64)
        .context("peer Gateway expiry missing")?;
    let now = now_ms();
    // A reconciled rotation may return an older, already-expiring receipt.
    // HTTP Date supplies the real Gateway clock; configured accessTtlMs alone
    // is not the remaining lifetime, especially across different host clocks.
    let remaining = expires_at.saturating_sub(reply.server_now_ms.unwrap_or(now));
    let ttl = value
        .get("accessTtlMs")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(remaining);
    let remaining = remaining.min(ttl);
    let margin = (ttl / 3).clamp(250, 60_000);
    let result = DeviceSecret {
        gateway: gateway.into(),
        device_id: text("deviceId")?,
        access_token: text("accessToken")?,
        refresh_token: text("refreshToken")?,
        rpc_token: text("rpcToken")?,
        authorization_generation: text("authorizationGeneration")?,
        expires_at,
        refresh_at_ms: now.saturating_add(remaining.saturating_sub(margin)),
    };
    if let Some(prior) = prior {
        ensure!(
            prior.device_id == result.device_id
                && prior.authorization_generation == result.authorization_generation,
            "peer device authorization family changed"
        );
    }
    Ok(result)
}
fn credential_key(profile: &PrivateDirectory, secret: &DeviceSecret) -> Result<String> {
    Ok(format!(
        "peer-gateway.{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "kcoder.peer-gateway.credential.v1",
            &secret.gateway,
            profile.directory_identity()?,
            &secret.device_id,
            format!("{:x}", Sha256::digest(serde_json::to_vec(secret)?)),
        ))?)
    ))
}
impl GatewayDeviceClient {
    pub(super) async fn pair(
        profile_path: &Path,
        url: &str,
        pairing_code: &str,
        mode: CredentialStoreMode,
        allow_insecure: bool,
    ) -> Result<Self> {
        ensure!(
            !pairing_code.is_empty(),
            "peer Gateway pairing credential required"
        );
        let base = canonical(url, allow_insecure)?;
        let profile = PrivateDirectory::open_existing(profile_path)?;
        profile.verify_private_directory()?;
        let _lock = super::credential_lock::CredentialMutationLease::from_locked(
            profile
                .try_exclusive_lock(OsStr::new(LOCK))?
                .context("peer Gateway credentials busy")?,
        );
        for name in [STORE, PENDING_PAIR] {
            match profile.entry_metadata(OsStr::new(name)) {
                Ok(_) => anyhow::bail!(
                    "peer Gateway enrollment already exists or is unconfirmed; inspect/revoke it before forgetting"
                ),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .build()?;
        let backend: Arc<dyn CredentialBackend> = Arc::new(OsCredentialBackend::new());
        let selected = if mode != CredentialStoreMode::File && backend.available() {
            CredentialStoreMode::Keyring
        } else {
            ensure!(
                mode != CredentialStoreMode::Keyring,
                "OS credential backend unavailable"
            );
            CredentialStoreMode::File
        };
        // Persist only a non-secret intent before HTTP. A missing receipt cannot
        // silently allocate a second durable device authorization on the next run.
        profile.atomic_replace(
            OsStr::new(PENDING_PAIR),
            &serde_json::to_vec(&serde_json::json!({"version":1,"gateway":base.as_str()}))?,
        )?;
        // Exactly one enrollment request. A lost receipt is not auto-retried.
        let response=http.post(base.join("api/mobile/session")?).json(&serde_json::json!({"token":pairing_code,"durableDeviceAuthorization":true,"deviceLabel":"KCoder TUI peer","requestInitialServers":false})).send().await.context("peer Gateway enrollment outcome unknown; do not blindly pair again")?;
        let secret = device(&reply(response).await?, None, base.as_str())?;
        let key = credential_key(&profile, &secret)?;
        let stored = StoredDevice {
            gateway: base.to_string(),
            backend: selected,
            credential_key: key,
            secret: None,
            pending_rotation_id: None,
        };
        let mut client = Self {
            http,
            base,
            profile,
            backend,
            stored,
            secret,
            allow_insecure,
        };
        client.persist()?;
        client
            .profile
            .remove_regular_file(OsStr::new(PENDING_PAIR))?;
        Ok(client)
    }
    fn persist(&mut self) -> Result<()> {
        self.profile.verify_private_directory()?;
        let previous_key = self.stored.credential_key.clone();
        let current_key = credential_key(&self.profile, &self.secret)?;
        if self.stored.backend == CredentialStoreMode::Keyring {
            // Publish new secret bytes before atomically changing their metadata
            // pointer. A crash leaves the old rotation receipt recoverable.
            self.backend
                .set(&current_key, &serde_json::to_string(&self.secret)?)?;
            self.stored.secret = None;
        } else {
            self.stored.secret = Some(self.secret.clone());
        }
        self.stored.credential_key = current_key.clone();
        self.profile
            .atomic_replace(OsStr::new(STORE), &serde_json::to_vec(&self.stored)?)?;
        if self.stored.backend == CredentialStoreMode::Keyring && previous_key != current_key {
            // The committed pointer is authoritative even if old-secret cleanup
            // fails. Never report the rotation as unaccepted and replay it.
            let _ = self.backend.delete(&previous_key);
        }
        Ok(())
    }
    pub(super) fn load(profile_path: &Path, allow_insecure: bool) -> Result<Self> {
        let profile = PrivateDirectory::open_existing(profile_path)?;
        let (stored, secret) = Self::load_path(&profile, allow_insecure)?;
        let base = canonical(&stored.gateway, allow_insecure)?;
        let backend: Arc<dyn CredentialBackend> = Arc::new(OsCredentialBackend::new());
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .build()?;
        Ok(Self {
            http,
            base,
            profile,
            backend,
            stored,
            secret,
            allow_insecure,
        })
    }
    fn load_path(
        profile: &PrivateDirectory,
        allow_insecure: bool,
    ) -> Result<(StoredDevice, DeviceSecret)> {
        use std::io::Read;
        profile.verify_private_directory()?;
        let mut file = profile.open_single_link_regular_file(OsStr::new(STORE))?;
        ensure!(
            file.metadata()?.len() <= MAX_REPLY as u64,
            "peer Gateway credential metadata too large"
        );
        let mut bytes = Vec::new();
        (&mut file)
            .take((MAX_REPLY + 1) as u64)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_REPLY,
            "peer Gateway credential metadata too large"
        );
        let stored: StoredDevice = serde_json::from_slice(&bytes)?;
        ensure!(
            stored.backend != CredentialStoreMode::Auto
                && (stored.backend == CredentialStoreMode::File) == stored.secret.is_some(),
            "peer Gateway credential storage mode invalid"
        );
        let base = canonical(&stored.gateway, allow_insecure)?;
        let backend: Arc<dyn CredentialBackend> = Arc::new(OsCredentialBackend::new());
        let secret: DeviceSecret = if stored.backend == CredentialStoreMode::Keyring {
            serde_json::from_str(
                &backend
                    .get(&stored.credential_key)?
                    .context("peer Gateway credential unavailable")?,
            )?
        } else {
            stored
                .secret
                .clone()
                .context("peer Gateway credential unavailable")?
        };
        ensure!(
            secret.gateway == base.as_str(),
            "peer Gateway credential origin changed"
        );
        let expected = credential_key(profile, &secret)?;
        ensure!(
            stored.credential_key == expected,
            "peer Gateway credential scope changed"
        );
        Ok((stored, secret))
    }
    pub(super) async fn refresh(&mut self) -> Result<()> {
        self.rotate(true).await.map(|_| ())
    }
    pub(super) fn refresh_delay(&self) -> Duration {
        let due = if self.secret.refresh_at_ms > 0 {
            self.secret.refresh_at_ms
        } else {
            self.secret.expires_at.saturating_sub(60_000)
        };
        Duration::from_millis(due.saturating_sub(now_ms()).clamp(250, 60_000))
    }
    pub(super) async fn refresh_if_due(&mut self) -> Result<bool> {
        self.rotate(false).await
    }
    async fn rotate(&mut self, force: bool) -> Result<bool> {
        let _lock = super::credential_lock::acquire(&self.profile, OsStr::new(LOCK)).await?;
        // Another TUI may have rotated this shared device already. Reload under
        // the same real profile lock instead of replaying a stale refresh token.
        let current = Self::load_path(&self.profile, self.allow_insecure)?;
        if current.0.gateway != self.base.as_str()
            || current.1.gateway != self.base.as_str()
            || current.1.device_id != self.secret.device_id
            || current.1.authorization_generation != self.secret.authorization_generation
        {
            return Err(DeviceEnrollmentChanged.into());
        }
        self.stored = current.0;
        self.secret = current.1;
        let due = if self.secret.refresh_at_ms > 0 {
            self.secret.refresh_at_ms
        } else {
            self.secret.expires_at.saturating_sub(60_000)
        };
        if !force && self.stored.pending_rotation_id.is_none() && now_ms() < due {
            return Ok(false);
        }
        let rotation = self
            .stored
            .pending_rotation_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.stored.pending_rotation_id = Some(rotation.clone());
        self.persist()?;
        let response=self.http.post(self.base.join("api/mobile/session/refresh")?).json(&serde_json::json!({"refreshToken":self.secret.refresh_token,"deviceId":self.secret.device_id,"rotationId":rotation})).send().await.context("peer Gateway refresh outcome unconfirmed")?;
        let secret = device(
            &reply(response).await?,
            Some(&self.secret),
            self.base.as_str(),
        )?;
        self.secret = secret;
        self.stored.pending_rotation_id = None;
        self.persist()?;
        Ok(true)
    }
    pub(super) async fn revoke(&self) -> Result<()> {
        let response = self
            .http
            .delete(self.base.join("api/mobile/session")?)
            .bearer_auth(&self.secret.access_token)
            .send()
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "peer Gateway revocation unconfirmed; retain the original credentials"
                )
            })?;
        ensure!(
            response.status().is_success(),
            "peer Gateway revocation unconfirmed; retain the original credentials"
        );
        Ok(())
    }
    pub(super) fn forget(profile_path: &Path) -> Result<()> {
        let profile = PrivateDirectory::open_existing(profile_path)?;
        profile.verify_private_directory()?;
        let _lock = super::credential_lock::CredentialMutationLease::from_locked(
            profile
                .try_exclusive_lock(OsStr::new(LOCK))?
                .context("peer Gateway credentials busy")?,
        );
        if let Ok((stored, _)) = Self::load_path(&profile, true)
            && stored.backend == CredentialStoreMode::Keyring
        {
            OsCredentialBackend::new().delete(&stored.credential_key)?;
        }
        for name in [STORE, PENDING_PAIR] {
            match profile.entry_metadata(OsStr::new(name)) {
                Ok(_) => profile.remove_regular_file(OsStr::new(name))?,
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
    pub(super) fn summary(&self) -> serde_json::Value {
        serde_json::json!({"gateway":self.base.as_str(),"deviceId":self.secret.device_id,"credentialBackend":self.stored.backend.as_str(),
            "refreshPending":self.stored.pending_rotation_id.is_some(),"accessExpiresAt":self.secret.expires_at})
    }
    pub(super) fn rpc_url(&self, server: &str, workspace: &str) -> Result<reqwest::Url> {
        let mut url = self.base.join("rpc")?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| anyhow::anyhow!("peer Gateway transport unavailable"))?;
        url.query_pairs_mut()
            .append_pair("token", &self.secret.rpc_token)
            .append_pair("channel", "agent-peer")
            .append_pair("server", server)
            .append_pair("workspace", workspace);
        Ok(url)
    }
    pub(super) fn access_token(&self) -> &str {
        &self.secret.access_token
    }
}

#[cfg(test)]
#[path = "gateway_auth_tests.rs"]
mod tests;
