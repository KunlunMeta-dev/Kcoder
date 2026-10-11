//! Authorization sessions belong to one app-server connection and never serialize secrets.

use super::{engine_factory::AppServerEngineFactory, mcp_processor};
use anyhow::{Result, bail};
use kcoder_app_protocol::{McpCallbackParams, McpCancelParams, McpLoginParams, McpLoginResult};
use kcoder_mcp::authorization::{discover_authorization_server, discover_challenged_resource};
use kcoder_mcp::authorization_flow::PendingAuthorization;
use kcoder_mcp::authorization_registration::{RegisteredClient, RegistrationMethod};
use reqwest::Url;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub(super) struct McpAuthorizationProcessor {
    pending: Arc<Mutex<HashMap<String, PendingFlow>>>,
}

struct PendingFlow {
    expires_at: Instant,
    selector: kcoder_app_protocol::McpServerParams,
    config: kcoder_mcp::McpServerConfig,
    flow: PendingAuthorization,
}

impl McpAuthorizationProcessor {
    pub(super) async fn login(
        &self,
        factory: AppServerEngineFactory,
        params: McpLoginParams,
    ) -> Result<McpLoginResult> {
        {
            let mut pending = self.pending.lock().await;
            pending.retain(|_, flow| flow.expires_at > Instant::now());
            if pending.len() >= 16 {
                bail!("Too many pending MCP authorizations");
            }
        }
        let selector = params.server;
        let config = mcp_processor::resolve(factory, selector.clone()).await?;
        if config.transport != "http"
            || config
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("authorization"))
        {
            bail!(
                "MCP browser authorization requires HTTP without a configured Authorization header"
            );
        }
        let endpoint =
            Url::parse(&config.url).map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
        let redirect = Url::parse(&params.redirect_uri)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth callback address"))?;
        kcoder_mcp::authorization::validate_endpoint(&endpoint)?;
        kcoder_mcp::authorization::validate_endpoint(&redirect)?;
        if redirect.query().is_some() {
            bail!("OAuth callback must not contain query parameters");
        }
        let transport =
            kcoder_mcp::StreamableHttpTransport::new(&config.url, &config.headers).await?;
        let mut client = kcoder_mcp::McpClient::with_transport(Box::new(transport));
        let error = match client.initialize().await {
            Ok(_) => bail!("MCP server did not request browser authorization"),
            Err(error) => error,
        };
        let challenge = error
            .downcast_ref::<kcoder_mcp::AuthenticationRequired>()
            .ok_or_else(|| {
                anyhow::anyhow!("MCP server did not provide an OAuth authentication challenge")
            })?;
        let protected = discover_challenged_resource(challenge).await?;
        let issuer = protected
            .authorization_servers
            .get(params.authorization_server_index)
            .ok_or_else(|| anyhow::anyhow!("Invalid authorization server selection"))?;
        let issuer = Url::parse(issuer).map_err(|_| anyhow::anyhow!("Invalid OAuth issuer"))?;
        let metadata = discover_authorization_server(&issuer).await?;
        let resource = Url::parse(&protected.resource)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth resource"))?;
        let manual = match params.client_id {
            Some(id) => {
                let method = match params.client_authentication.as_deref().unwrap_or("none") {
                    "none" => RegistrationMethod::Public,
                    "client_secret_basic" => RegistrationMethod::Basic,
                    "client_secret_post" => RegistrationMethod::Post,
                    _ => bail!("Unsupported OAuth client authentication method"),
                };
                Some(RegisteredClient::manual(
                    &metadata,
                    id,
                    params.client_secret.map(Into::into),
                    method,
                    &redirect,
                )?)
            }
            None => {
                if params.client_secret.is_some() || params.client_authentication.is_some() {
                    bail!("Explicit OAuth client authentication requires a client ID");
                }
                None
            }
        };
        let scopes = kcoder_mcp::authorization::select_authorization_scopes(
            &params.scopes,
            challenge.challenges(),
            &protected.scopes_supported,
        )?;
        let store = crate::mcp_connection::token_store()?;
        let flow = PendingAuthorization::begin_for_endpoint(
            &store, &endpoint, &metadata, &resource, &redirect, &scopes, manual,
        )
        .await?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let result = McpLoginResult {
            flow_id: flow_id.clone(),
            authorization_url: flow.authorization_url().as_str().into(),
        };
        let mut pending = self.pending.lock().await;
        pending.retain(|_, flow| flow.expires_at > Instant::now());
        if pending.len() >= 16 {
            bail!("Too many pending MCP authorizations");
        }
        pending.insert(
            flow_id,
            PendingFlow {
                expires_at: Instant::now() + Duration::from_secs(600),
                selector,
                config,
                flow,
            },
        );
        Ok(result)
    }

    pub(super) async fn callback(
        &self,
        factory: AppServerEngineFactory,
        params: McpCallbackParams,
    ) -> Result<()> {
        let callback = Url::parse(&params.callback_url)
            .map_err(|_| anyhow::anyhow!("Invalid OAuth callback"))?;
        let mut pending = self.pending.lock().await;
        pending.retain(|_, flow| flow.expires_at > Instant::now());
        let pending_flow = pending.get_mut(&params.flow_id).ok_or_else(|| {
            anyhow::anyhow!("MCP authorization flow is unavailable on this connection")
        })?;
        let current = mcp_processor::resolve(factory, pending_flow.selector.clone()).await?;
        if current.transport != pending_flow.config.transport
            || current.url != pending_flow.config.url
            || current.headers != pending_flow.config.headers
        {
            bail!("MCP configuration changed during authorization; start authorization again");
        }
        let store = crate::mcp_connection::token_store()?;
        pending_flow.flow.complete(&store, &callback).await?;
        pending.remove(&params.flow_id);
        Ok(())
    }

    pub(super) async fn cancel(&self, params: McpCancelParams) -> Result<()> {
        let mut pending = self.pending.lock().await;
        let mut flow = pending.remove(&params.flow_id).ok_or_else(|| {
            anyhow::anyhow!("MCP authorization flow is unavailable on this connection")
        })?;
        flow.flow.cancel();
        Ok(())
    }
}
