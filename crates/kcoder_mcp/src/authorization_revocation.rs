//! Original private OAuth store revocation receipts, separate from local logout.
//! RFC 7009 requests use only RFC 8414 metadata saved by the original issuer flow.
use super::*;
use anyhow::ensure;
use kcoder_types::{
    integrations::core::IntegrationRevisionRef,
    mcp_authorization::{
        McpProviderRevocationPhase as Phase, McpProviderRevocationReason as Reason,
        McpProviderRevocationReceipt as Receipt, McpProviderRevocationSourceState as SourceState,
    },
};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX: &str = "provider-revoke-";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginalRevocation {
    version: u32,
    account: Option<String>,
    source_fingerprint: String,
    endpoint: String,
    association_revision: Option<String>,
    credential_revision: Option<String>,
    expires_at_ms: u64,
    receipt: Receipt,
}
fn now_ms() -> Result<u64> {
    u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()).map_err(Into::into)
}
fn random_revision() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_RANDOM_UNAVAILABLE"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn key(request_id: &str) -> Result<String> {
    ensure!(
        !request_id.is_empty()
            && request_id.len() <= 128
            && !request_id.chars().any(char::is_control),
        "MCP_REVOCATION_INPUT_INVALID"
    );
    Ok(format!(
        "{PREFIX}{:x}",
        Sha256::digest(request_id.as_bytes())
    ))
}
async fn operation_lock(store: &OAuthTokenStore, name: String) -> Result<File> {
    let directory = store.directory.clone();
    tokio::task::spawn_blocking(move || acquire_lock(&directory, &name))
        .await
        .context("MCP_REVOCATION_LEASE_UNAVAILABLE")?
}
fn load(store: &OAuthTokenStore, request_id: &str) -> Result<Option<OriginalRevocation>> {
    let Some(bytes) = read_record(&store.directory, &format!("{}.json", key(request_id)?))? else {
        return Ok(None);
    };
    let original: OriginalRevocation = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_RECEIPT_INVALID"))?;
    ensure!(
        original.version == 1
            && original.receipt.request_id == request_id
            && original.receipt.intent_ref.is_some()
            && !original.receipt.local_credentials_removed,
        "MCP_REVOCATION_RECEIPT_INVALID"
    );
    Ok(Some(original))
}
fn save(store: &OAuthTokenStore, original: &OriginalRevocation) -> Result<()> {
    let bytes = serde_json::to_vec(original)
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_RECEIPT_INVALID"))?;
    ensure!(bytes.len() <= 16 * 1024, "MCP_REVOCATION_RECEIPT_INVALID");
    store.directory.atomic_replace(
        OsStr::new(&format!("{}.json", key(&original.receipt.request_id)?)),
        &bytes,
    )
}
fn project(original: &OriginalRevocation, source_fingerprint: Option<&str>) -> Receipt {
    let mut receipt = original.receipt.clone();
    receipt.current_source_matches =
        source_fingerprint == Some(original.source_fingerprint.as_str());
    receipt.source_state = match source_fingerprint {
        None => SourceState::Unavailable,
        Some(value) if value == original.source_fingerprint => SourceState::Matches,
        Some(_) => SourceState::Changed,
    };
    receipt
}
fn finish(
    store: &OAuthTokenStore,
    original: &mut OriginalRevocation,
    phase: Phase,
    reason: Reason,
) -> Result<()> {
    original.receipt.phase = phase;
    original.receipt.reason = reason;
    save(store, original)
}
fn revocation_endpoint(metadata: &AuthorizationServerMetadata) -> Result<Option<Url>> {
    let Some(endpoint) = metadata.revocation_endpoint.as_deref() else {
        return Ok(None);
    };
    let endpoint =
        Url::parse(endpoint).map_err(|_| anyhow::anyhow!("MCP_REVOCATION_ENDPOINT_INVALID"))?;
    validate_endpoint(&endpoint)?;
    let issuer = Url::parse(&metadata.issuer)
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_ISSUER_INVALID"))?;
    ensure!(
        issuer.scheme() != "https" || endpoint.scheme() == "https",
        "MCP_REVOCATION_ENDPOINT_DOWNGRADE"
    );
    Ok(Some(endpoint))
}
fn revocation_authentication(
    metadata: &AuthorizationServerMetadata,
    original: &ClientAuthentication,
) -> Option<ClientAuthentication> {
    let allows = |name: &str| {
        metadata
            .revocation_endpoint_auth_methods_supported
            .as_ref()
            .map_or(name == "client_secret_basic", |methods| {
                methods.iter().any(|method| method == name)
            })
    };
    match original {
        ClientAuthentication::Public => allows("none").then_some(ClientAuthentication::Public),
        ClientAuthentication::Basic(secret) if allows("client_secret_basic") => {
            Some(ClientAuthentication::Basic(secret.clone()))
        }
        ClientAuthentication::Post(secret) if allows("client_secret_post") => {
            Some(ClientAuthentication::Post(secret.clone()))
        }
        ClientAuthentication::Basic(secret) | ClientAuthentication::Post(secret)
            if allows("client_secret_basic") =>
        {
            Some(ClientAuthentication::Basic(secret.clone()))
        }
        ClientAuthentication::Basic(secret) | ClientAuthentication::Post(secret)
            if allows("client_secret_post") =>
        {
            Some(ClientAuthentication::Post(secret.clone()))
        }
        _ => None,
    }
}

impl OAuthTokenStore {
    /// Receipt reads never create a credential directory or coordinator.
    pub fn open_existing_for_account(path: &Path, account: Option<&str>) -> Result<Option<Self>> {
        validate_account(account)?;
        match PrivateDirectory::open_existing(path) {
            Ok(directory) => {
                directory.verify_private_directory()?;
                Ok(Some(Self {
                    directory: Arc::new(directory),
                    account: account.map(str::to_owned),
                }))
            }
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
    /// Read the original durable receipt without taking a writer lock or retrying HTTP.
    pub fn read_provider_revocation(
        &self,
        request_id: &str,
        source_fingerprint: Option<&str>,
    ) -> Result<Receipt> {
        Ok(match load(self, request_id)? {
            Some(original) => project(&original, source_fingerprint),
            None => Receipt {
                request_id: request_id.into(),
                intent_ref: None,
                phase: Phase::Unknown,
                reason: Reason::OriginalReceiptUnavailable,
                local_credentials_removed: false,
                current_source_matches: false,
                source_state: SourceState::Unavailable,
            },
        })
    }

    /// Non-OAuth/native-unsupported sources still retain an original receipt,
    /// without reading, clearing or substituting another account's credentials.
    pub async fn record_unsupported_provider_revocation(
        &self,
        request_id: &str,
        source_fingerprint: &str,
        reason: Reason,
    ) -> Result<Receipt> {
        let _operation = operation_lock(self, key(request_id)?).await?;
        if let Some(original) = load(self, request_id)? {
            return Ok(project(&original, Some(source_fingerprint)));
        }
        let _allocation = operation_lock(self, "provider-revoke-allocation".into()).await?;
        ensure!(
            self.directory.count_regular_files_bounded(
                |name| name.to_string_lossy().starts_with(PREFIX)
                    && name.to_string_lossy().ends_with(".json"),
                1025
            )? < 1024,
            "MCP_REVOCATION_CAPACITY"
        );
        let nonce = random_revision()?;
        let original = OriginalRevocation {
            version: 1,
            account: self.account.clone(),
            source_fingerprint: source_fingerprint.into(),
            endpoint: String::new(),
            association_revision: None,
            credential_revision: None,
            expires_at_ms: now_ms()?,
            receipt: Receipt {
                request_id: request_id.into(),
                intent_ref: Some(IntegrationRevisionRef {
                    id: format!("mcp-revoke-{}", &nonce[..32]),
                    revision: nonce,
                }),
                phase: Phase::Unsupported,
                reason,
                local_credentials_removed: false,
                current_source_matches: true,
                source_state: SourceState::Matches,
            },
        };
        save(self, &original)?;
        Ok(project(&original, Some(source_fingerprint)))
    }

    /// Cancellation can retire only an unsubmitted prepared intent. A possible
    /// provider request stays unknown/accepted, never becomes "not executed".
    pub async fn cancel_provider_revocation(
        &self,
        request_id: &str,
        intent: &IntegrationRevisionRef,
        source_fingerprint: Option<&str>,
    ) -> Result<Receipt> {
        let _operation = operation_lock(self, key(request_id)?).await?;
        let mut original = load(self, request_id)?.context("MCP_REVOCATION_ORIGINAL_REQUIRED")?;
        ensure!(
            original.receipt.intent_ref.as_ref() == Some(intent),
            "MCP_REVOCATION_INTENT_CHANGED"
        );
        if original.receipt.phase == Phase::Prepared {
            finish(
                self,
                &mut original,
                Phase::Rejected,
                Reason::PreparationCancelled,
            )?;
        }
        Ok(project(&original, source_fingerprint))
    }

    /// Preparing snapshots the original issuer/client/resource and current token
    /// version. It sends no request and grants no model/tool authority.
    pub async fn prepare_provider_revocation(
        &self,
        endpoint: &Url,
        request_id: &str,
        source_fingerprint: &str,
    ) -> Result<Receipt> {
        let _operation = operation_lock(self, key(request_id)?).await?;
        if let Some(original) = load(self, request_id)? {
            return Ok(project(&original, Some(source_fingerprint)));
        }
        let allocation = operation_lock(self, "provider-revoke-allocation".into()).await?;
        ensure!(
            self.directory.count_regular_files_bounded(
                |name| name.to_string_lossy().starts_with(PREFIX)
                    && name.to_string_lossy().ends_with(".json"),
                1025
            )? < 1024,
            "MCP_REVOCATION_CAPACITY"
        );
        let nonce = random_revision()?;
        let mut original = OriginalRevocation {
            version: 1,
            account: self.account.clone(),
            source_fingerprint: source_fingerprint.into(),
            endpoint: endpoint.as_str().into(),
            association_revision: None,
            credential_revision: None,
            expires_at_ms: now_ms()? + 10 * 60 * 1000,
            receipt: Receipt {
                request_id: request_id.into(),
                intent_ref: Some(IntegrationRevisionRef {
                    id: format!("mcp-revoke-{}", &nonce[..32]),
                    revision: nonce,
                }),
                phase: Phase::Unsupported,
                reason: Reason::AuthorizationUnavailable,
                local_credentials_removed: false,
                current_source_matches: true,
                source_state: SourceState::Matches,
            },
        };
        original.receipt.phase = Phase::Unknown;
        original.receipt.reason = Reason::OutcomeUnconfirmed;
        save(self, &original)?;
        drop(allocation);
        original.receipt.phase = Phase::Unsupported;
        original.receipt.reason = Reason::AuthorizationUnavailable;
        let association = self.acquire_connection(endpoint).await?;
        if let Some(saved) = association.load()? {
            original.association_revision = Some(association.revision()?);
            if revocation_endpoint(&saved.metadata)?.is_some() {
                let registration = self
                    .acquire_registration(&saved.metadata, &saved.redirect_uri)
                    .await?;
                let client = registration.load()?;
                drop(registration);
                if let Some(client) = client {
                    ensure!(
                        client.client_id() == saved.binding.client_id,
                        "MCP_REVOCATION_CLIENT_CHANGED"
                    );
                    if revocation_authentication(&saved.metadata, client.authentication()?)
                        .is_some()
                    {
                        let lease = self.acquire(saved.binding).await?;
                        if lease.load()?.is_some() {
                            let bytes = read_record(&lease.directory, &lease.name)?
                                .context("MCP_REVOCATION_CREDENTIAL_UNAVAILABLE")?;
                            let (prepared, revision) =
                                crate::authorization_tokens::prepare_revocation_revision(&bytes)?;
                            if bytes.as_slice() != prepared.as_slice() {
                                lease
                                    .directory
                                    .atomic_replace(OsStr::new(&lease.name), &prepared)?;
                            }
                            original.credential_revision = Some(revision);
                            original.receipt.phase = Phase::Prepared;
                            original.receipt.reason = Reason::AwaitingConfirmation;
                        }
                    } else {
                        original.receipt.reason = Reason::AuthenticationUnsupported;
                    }
                }
            } else {
                original.receipt.reason = Reason::EndpointNotAdvertised;
            }
        }
        save(self, &original)?;
        Ok(project(&original, Some(source_fingerprint)))
    }

    /// Only a prepared native reference may dispatch. Unknown/accepted/unsupported
    /// original requests only return their receipts, including after restart.
    #[cfg(test)]
    async fn commit_provider_revocation(
        &self,
        endpoint: &Url,
        request_id: &str,
        intent: &IntegrationRevisionRef,
        source_fingerprint: &str,
    ) -> Result<Receipt> {
        self.commit_provider_revocation_revalidated(
            endpoint,
            request_id,
            intent,
            source_fingerprint,
            || Ok(()),
        )
        .await
    }

    pub async fn commit_provider_revocation_revalidated<F>(
        &self,
        endpoint: &Url,
        request_id: &str,
        intent: &IntegrationRevisionRef,
        source_fingerprint: &str,
        revalidate: F,
    ) -> Result<Receipt>
    where
        F: Fn() -> Result<()> + Send + Sync,
    {
        let _operation = operation_lock(self, key(request_id)?).await?;
        let mut original = load(self, request_id)?.context("MCP_REVOCATION_ORIGINAL_REQUIRED")?;
        ensure!(
            original.receipt.intent_ref.as_ref() == Some(intent),
            "MCP_REVOCATION_INTENT_CHANGED"
        );
        if original.receipt.phase != Phase::Prepared {
            return Ok(project(&original, Some(source_fingerprint)));
        }
        if original.account != self.account
            || original.source_fingerprint != source_fingerprint
            || original.endpoint != endpoint.as_str()
        {
            finish(self, &mut original, Phase::Rejected, Reason::SourceChanged)?;
            return Ok(project(&original, Some(source_fingerprint)));
        }
        if now_ms()? >= original.expires_at_ms {
            finish(self, &mut original, Phase::Rejected, Reason::IntentExpired)?;
            return Ok(project(&original, Some(source_fingerprint)));
        }
        let association = self.acquire_connection(endpoint).await?;
        if Some(association.revision()?) != original.association_revision {
            finish(self, &mut original, Phase::Rejected, Reason::SourceChanged)?;
            return Ok(project(&original, Some(source_fingerprint)));
        }
        let saved = association
            .load()?
            .context("MCP_REVOCATION_AUTHORIZATION_UNAVAILABLE")?;
        let Some(revoke_url) = revocation_endpoint(&saved.metadata)? else {
            finish(
                self,
                &mut original,
                Phase::Unsupported,
                Reason::EndpointNotAdvertised,
            )?;
            return Ok(project(&original, Some(source_fingerprint)));
        };
        let registration = self
            .acquire_registration(&saved.metadata, &saved.redirect_uri)
            .await?;
        let client = registration
            .load()?
            .context("MCP_REVOCATION_CLIENT_UNAVAILABLE")?;
        ensure!(
            client.client_id() == saved.binding.client_id,
            "MCP_REVOCATION_CLIENT_CHANGED"
        );
        let Some(authentication) =
            revocation_authentication(&saved.metadata, client.authentication()?)
        else {
            finish(
                self,
                &mut original,
                Phase::Unsupported,
                Reason::AuthenticationUnsupported,
            )?;
            return Ok(project(&original, Some(source_fingerprint)));
        };
        drop(registration);
        let lease = self.acquire(saved.binding).await?;
        let Some(tokens) = lease.load()? else {
            finish(
                self,
                &mut original,
                Phase::Rejected,
                Reason::CredentialsChanged,
            )?;
            return Ok(project(&original, Some(source_fingerprint)));
        };
        let Some(bytes) = read_record(&lease.directory, &lease.name)? else {
            finish(
                self,
                &mut original,
                Phase::Rejected,
                Reason::CredentialsChanged,
            )?;
            return Ok(project(&original, Some(source_fingerprint)));
        };
        let revision = original
            .credential_revision
            .clone()
            .context("MCP_REVOCATION_CREDENTIAL_INVALID")?;
        let pending = match crate::authorization_tokens::mark_provider_revocation(
            &bytes,
            &revision,
            request_id,
            Some(false),
        ) {
            Ok(pending) => pending,
            Err(_) => {
                finish(
                    self,
                    &mut original,
                    Phase::Rejected,
                    Reason::CredentialsChanged,
                )?;
                return Ok(project(&original, Some(source_fingerprint)));
            }
        };
        if now_ms()? >= original.expires_at_ms {
            finish(self, &mut original, Phase::Rejected, Reason::IntentExpired)?;
            return Ok(project(&original, Some(source_fingerprint)));
        }
        // Token/association leases cannot prove current host configuration.
        // Revalidate after every awaited lease, without reentering OAuth locks.
        if revalidate().is_err() {
            finish(self, &mut original, Phase::Rejected, Reason::SourceChanged)?;
            return Ok(project(&original, Some(source_fingerprint)));
        }
        // Both durable unknown receipt and private credential fence precede HTTP.
        finish(
            self,
            &mut original,
            Phase::Unknown,
            Reason::OutcomeUnconfirmed,
        )?;
        lease
            .directory
            .atomic_replace(OsStr::new(&lease.name), &pending)?;
        // A later configuration change keeps the original durable Unknown/fence.
        // Never restore credentials or replay merely because no POST was observed.
        if revalidate().is_err() {
            return Ok(project(&original, Some(source_fingerprint)));
        }
        let outcome = request_revocation(&revoke_url, &tokens, &authentication).await;
        match outcome {
            Ok((phase, reason)) => {
                let accepted = phase == Phase::Accepted;
                let finalized = crate::authorization_tokens::mark_provider_revocation(
                    &pending,
                    &revision,
                    request_id,
                    accepted.then_some(true),
                )?;
                lease
                    .directory
                    .atomic_replace(OsStr::new(&lease.name), &finalized)?;
                finish(self, &mut original, phase, reason)?;
            }
            Err(_) => { /* The original durable unknown state is authoritative. */ }
        }
        Ok(project(&original, Some(source_fingerprint)))
    }
}

async fn request_revocation(
    endpoint: &Url,
    tokens: &OAuthTokens,
    authentication: &ClientAuthentication,
) -> Result<(Phase, Reason)> {
    let (token, hint) = tokens
        .refresh_token()
        .map_or((tokens.access_token(), "access_token"), |value| {
            (value, "refresh_token")
        });
    let mut form = vec![("token", token), ("token_type_hint", hint)];
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(15))
        .build()
        .context("MCP_REVOCATION_HTTP_UNAVAILABLE")?;
    let mut request = client.post(endpoint.clone());
    match authentication {
        ClientAuthentication::Public => form.push(("client_id", tokens.client_id())),
        ClientAuthentication::Post(secret) => {
            ensure!(!secret.is_empty(), "MCP_REVOCATION_CLIENT_UNAVAILABLE");
            form.push(("client_id", tokens.client_id()));
            form.push(("client_secret", secret.as_str()));
        }
        ClientAuthentication::Basic(secret) => {
            ensure!(!secret.is_empty(), "MCP_REVOCATION_CLIENT_UNAVAILABLE");
            let id = crate::authorization_tokens::basic_component(tokens.client_id())?;
            let secret = crate::authorization_tokens::basic_component(secret)?;
            request = request.basic_auth(id.as_str(), Some(secret.as_str()));
        }
    }
    let response = request
        .form(&form)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_OUTCOME_UNCONFIRMED"))?;
    if response.status() == reqwest::StatusCode::OK {
        return Ok((Phase::Accepted, Reason::ProviderAccepted));
    }
    if response.status().is_client_error() {
        use futures::StreamExt;
        let mut bytes = Zeroizing::new(Vec::new());
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| anyhow::anyhow!("MCP_REVOCATION_OUTCOME_UNCONFIRMED"))?;
            ensure!(
                bytes.len() + chunk.len() <= 16 * 1024,
                "MCP_REVOCATION_OUTCOME_UNCONFIRMED"
            );
            bytes.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct Failure {
            error: Zeroizing<String>,
        }
        return match serde_json::from_slice::<Failure>(&bytes)
            .ok()
            .as_ref()
            .map(|value| value.error.as_str())
        {
            Some("unsupported_token_type") => {
                Ok((Phase::Unsupported, Reason::TokenTypeUnsupported))
            }
            Some("invalid_client" | "invalid_request" | "unauthorized_client") => {
                Ok((Phase::Rejected, Reason::ProviderRejected))
            }
            _ => Err(anyhow::anyhow!("MCP_REVOCATION_OUTCOME_UNCONFIRMED")),
        };
    }
    anyhow::bail!("MCP_REVOCATION_OUTCOME_UNCONFIRMED")
}

#[cfg(test)]
#[path = "authorization_revocation/tests.rs"]
mod tests;
