//! Facts read through the actual ready application-host pipe. Facts never authorize tools.
use super::super::core::NativeIntegrationContext;
use super::{NativeConnectivityLeaseFacade, NativeConnectivityParent};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait NativeConnectivityFactPipe: Send + Sync {
    /// Implement only with the already authenticated target supervisor's actual child pipe.
    async fn read_owned(
        &self,
        parent: &NativeConnectivityParent,
        method: &'static str,
        payload: Value,
    ) -> Result<Value>;

    async fn read_on_lease(
        &self,
        lease: &NativeFactReadLease<'_>,
        method: &'static str,
        payload: Value,
    ) -> Result<(Value, String)> {
        lease.read_via(self, method, payload).await
    }
}

pub struct NativeFactReadLease<'a> {
    pub context: &'a NativeIntegrationContext,
    pub facade: &'a NativeConnectivityLeaseFacade,
    pub parent: &'a NativeConnectivityParent,
    pub id: &'a str,
}

impl NativeFactReadLease<'_> {
    pub async fn read_via<P: NativeConnectivityFactPipe + ?Sized>(
        &self,
        pipe: &P,
        method: &'static str,
        payload: Value,
    ) -> Result<(Value, String)> {
        self.facade
            .require_ready(self.context, Some(self.parent), self.id)?;
        let value = pipe.read_owned(self.parent, method, payload).await?;
        let namespace = self
            .facade
            .ready_namespace(self.context, Some(self.parent), self.id)?;
        Ok((value, namespace.into()))
    }
}
