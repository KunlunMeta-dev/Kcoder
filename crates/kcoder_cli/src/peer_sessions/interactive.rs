//! The outer interactive owner retains leases; weak hooks never prolong the REPL.
use super::*;
use kcoder_engine::interactive_session_runtime::{
    InteractiveSessionLifecycle, SessionCommunicationBinding,
};
use serde_json::{Value, json};
use std::sync::Weak;
use std::time::{Duration, Instant};

struct RuntimeBinding {
    local: Option<host::LocalPeerRuntime>,
    gateway: Option<gateway_runtime::GatewayPeerRuntime>,
    owner: AppStateLifecycleIdentity,
    configuration: Value,
    binding: SessionCommunicationBinding,
    transport_failed: bool,
    next_policy_observation: Instant,
}

struct InteractiveOwner {
    state: AppState,
    paths: kcoder_config::ConfigPaths,
    policy: Arc<crate::app_server::session_messages::policy::PeerMessagePolicy>,
    gateway: Option<(String, bool)>,
    factory: Option<crate::app_server::AppServerEngineFactory>,
    closed: AtomicBool,
    binding: tokio::sync::Mutex<RuntimeBinding>,
}

/// Held only by the actual CLI stack until its original REPL has exited.
pub(crate) struct InteractivePeerRuntime(Arc<InteractiveOwner>);
struct WeakInteractiveLifecycle(Weak<InteractiveOwner>);

fn selected_configuration(engine: &QueryEngine) -> Result<Value> {
    let settings = engine
        .settings
        .try_read()
        .map_err(|_| anyhow::anyhow!("peer_settings_busy"))?;
    // This comparison is private and contains no transport credentials. It is
    // only a refresh hint; operations still check policy and ACL every time.
    Ok(json!({
        "provider": settings.active_provider,
        "model": settings.model,
        "capabilities": settings.model_capabilities,
        "tools": settings.tools,
        "sessionMode": engine.state.session_mode(),
        "workspace": engine.state.cwd(),
    }))
}

fn configuration(
    engine: &QueryEngine,
    policy: &crate::app_server::session_messages::policy::PeerMessagePolicy,
) -> Result<Value> {
    let selected = selected_configuration(engine)?;
    let policy = policy.read().ok();
    // An unavailable optional policy removes communication. The native
    // session owner remains held so ordinary coding can continue safely.
    Ok(
        json!({"selection": selected, "policyRevision": policy.as_ref().map(|policy| &policy.revision),
        "policyEnabled": policy.as_ref().is_some_and(|policy| policy.enabled)}),
    )
}

impl InteractivePeerRuntime {
    #[cfg(test)]
    pub(crate) fn capture(
        engine: &mut QueryEngine,
        paths: kcoder_config::ConfigPaths,
        local: Option<host::LocalPeerRuntime>,
        gateway: Option<gateway_runtime::GatewayPeerRuntime>,
        selected_gateway: Option<(String, bool)>,
    ) -> Result<Self> {
        Self::capture_with_factory(engine, paths, local, gateway, selected_gateway, None)
    }
    pub(crate) fn capture_with_factory(
        engine: &mut QueryEngine,
        paths: kcoder_config::ConfigPaths,
        local: Option<host::LocalPeerRuntime>,
        gateway: Option<gateway_runtime::GatewayPeerRuntime>,
        selected_gateway: Option<(String, bool)>,
        factory: Option<crate::app_server::AppServerEngineFactory>,
    ) -> Result<Self> {
        let transport_failed = selected_gateway.is_some() && gateway.is_none();
        let policy = Arc::new(
            crate::app_server::session_messages::policy::PeerMessagePolicy::capture(paths.clone())?,
        );
        let observed_configuration = configuration(engine, &policy)?;
        let owner = Arc::new(InteractiveOwner {
            state: engine.state.clone(),
            paths: paths.clone(),
            policy,
            gateway: selected_gateway,
            factory,
            closed: AtomicBool::new(false),
            binding: tokio::sync::Mutex::new(RuntimeBinding {
                local,
                gateway,
                transport_failed,
                owner: engine.state.inspection_lifecycle_identity(),
                configuration: observed_configuration,
                binding: engine.session_communication_binding(),
                next_policy_observation: Instant::now() + Duration::from_secs(1),
            }),
        });
        *engine =
            engine
                .clone()
                .with_interactive_session_lifecycle(Arc::new(WeakInteractiveLifecycle(
                    Arc::downgrade(&owner),
                )));
        Ok(Self(owner))
    }

    pub(crate) async fn close(&self) {
        self.0.closed.store(true, Ordering::Release);
        let mut binding = self.0.binding.lock().await;
        binding.gateway.take();
        if let Some(local) = binding.local.as_mut() {
            local.retire_writer().await;
        }
        binding.local.take();
    }
}

impl Drop for InteractivePeerRuntime {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
        if let Ok(mut binding) = self.0.binding.try_lock() {
            binding.gateway.take();
            binding.local.take();
        }
    }
}

#[async_trait::async_trait]
impl InteractiveSessionLifecycle for WeakInteractiveLifecycle {
    async fn refresh(&self, engine: QueryEngine) -> Result<QueryEngine> {
        let owner = self.0.upgrade().context("interactive_peer_owner_closed")?;
        if !engine.state.shares_state_with(&owner.state) {
            return engine.without_session_communication();
        }
        ensure!(
            !owner.closed.load(Ordering::Acquire),
            "interactive_peer_owner_closed"
        );
        let selected = selected_configuration(&engine)?;
        let mut current = owner.binding.lock().await;
        let owner_deadline = Instant::now() + Duration::from_secs(1);
        let same_owner = loop {
            match current.owner.try_matches(&engine.state) {
                Some(current) => break current,
                None if Instant::now() < owner_deadline => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                None => anyhow::bail!("interactive_peer_owner_observation_unavailable"),
            }
        };
        if same_owner
            && current.configuration.get("selection") == Some(&selected)
            && Instant::now() < current.next_policy_observation
        {
            return engine.with_session_communication_binding(&current.binding);
        }
        let policy = owner.policy.clone();
        let observed = engine.clone();
        let configuration =
            tokio::task::spawn_blocking(move || configuration(&observed, &policy)).await??;
        current.next_policy_observation = Instant::now() + Duration::from_secs(1);
        ensure!(
            !owner.closed.load(Ordering::Acquire),
            "interactive_peer_owner_closed"
        );
        if same_owner && current.configuration == configuration {
            return engine.with_session_communication_binding(&current.binding);
        }
        if same_owner && let Some(local) = &current.local {
            ensure!(
                local.matches_owner(&engine),
                "interactive_peer_native_owner_changed"
            );
        }

        // Revoke the old source before publishing any replacement registry.
        // Original admission facts transfer only within the same State owner.
        current.gateway.take();
        if !same_owner && let Some(local) = current.local.as_mut() {
            local.retire_writer().await;
        }
        let old_local = current.local.take();
        if let Some(local) = &old_local
            && let Ok(source) = local.source()
        {
            source.active.store(false, Ordering::Release);
        }
        let mut engine = engine.without_session_communication()?;
        let paths = owner.paths.clone();
        let factory = owner.factory.clone();
        let failed = current.transport_failed;
        let policy_enabled =
            configuration.get("policyEnabled").and_then(Value::as_bool) == Some(true);
        let prepared = tokio::task::spawn_blocking(move || -> Result<_> {
            let mut local = old_local;
            if !same_owner {
                // Only the old owned carrier is closed. Its history/queue and
                // every other process's lease remain untouched.
                local.take();
            }
            if let Some(local) = local.as_mut() {
                if !policy_enabled {
                    local.disable_communication();
                } else if !failed && local.rebind(&mut engine, paths).is_err() {
                    local.disable_communication();
                    engine = engine.without_session_communication()?;
                }
            } else {
                let mut replacement =
                    host::LocalPeerRuntime::hold_native_owner_with_factory(&engine, factory)?;
                if policy_enabled && !failed && replacement.rebind(&mut engine, paths).is_err() {
                    replacement.disable_communication();
                    engine = engine.without_session_communication()?;
                }
                local = Some(replacement);
            }
            Ok((engine, local))
        })
        .await??;
        engine = prepared.0;
        current.local = prepared.1;
        if !current.transport_failed
            && let Some((server, insecure)) = &owner.gateway
            && let Some(local) = current
                .local
                .as_ref()
                .filter(|local| local.source().is_ok())
        {
            match gateway_runtime::attach(&mut engine, local, &owner.paths, server, *insecure).await
            {
                Ok(gateway) => current.gateway = Some(gateway),
                Err(_) => {
                    current.transport_failed = true;
                    engine = engine.without_session_communication()?;
                    if let Some(local) = current.local.as_mut() {
                        local.disable_communication();
                    }
                }
            }
        }
        if owner.closed.load(Ordering::Acquire) {
            current.gateway.take();
            current.local.take();
            anyhow::bail!("interactive_peer_owner_closed");
        }
        current.owner = engine.state.inspection_lifecycle_identity();
        current.configuration = configuration;
        current.binding = engine.session_communication_binding();
        Ok(engine)
    }
}
