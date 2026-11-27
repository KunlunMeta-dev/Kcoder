//! Native dispatch is rechecked after a transport wait, before an effect is sent.
use super::*;

#[async_trait]
pub trait NativeTransportAuthorization: Send + Sync {
    async fn verify(&self) -> Result<(), ToolError>;
    async fn verify_resource(&self, _uri: &str) -> Result<(), ToolError> {
        Err(ToolError::Execution(
            "NATIVE_RESOURCE_AUTHORITY_UNAVAILABLE".into(),
        ))
    }
}
struct IntersectedTransport {
    previous: Arc<dyn NativeTransportAuthorization>,
    next: Arc<dyn NativeTransportAuthorization>,
}
#[async_trait]
impl NativeTransportAuthorization for IntersectedTransport {
    async fn verify(&self) -> Result<(), ToolError> {
        self.previous.verify().await?;
        self.next.verify().await
    }
    async fn verify_resource(&self, uri: &str) -> Result<(), ToolError> {
        self.previous.verify_resource(uri).await?;
        self.next.verify_resource(uri).await
    }
}
impl ToolContext {
    /// Host-owned capability, never reconstructed from model input or a source annotation.
    pub fn with_native_transport_authorization(
        mut self,
        authority: Arc<dyn NativeTransportAuthorization>,
    ) -> Self {
        self.native_transport = Some(match self.native_transport.take() {
            Some(previous) => Arc::new(IntersectedTransport {
                previous,
                next: authority,
            }),
            None => authority,
        });
        self
    }
    pub async fn verify_native_resource_authorization(&self, uri: &str) -> Result<(), ToolError> {
        if let Some(authority) = &self.native_transport {
            tokio::select! {biased;
                _=self.cancelled()=>Err(ToolError::Execution("NATIVE_TRANSPORT_CANCELLED".into())),
                result=tokio::time::timeout(std::time::Duration::from_secs(5),authority.verify_resource(uri))=>
                    result.unwrap_or_else(|_|Err(ToolError::Execution("NATIVE_RESOURCE_AUTHORITY_UNAVAILABLE".into())))
            }
        } else {
            Ok(())
        }
    }
    pub async fn verify_native_transport_authorization(&self) -> Result<(), ToolError> {
        if let Some(authority) = &self.native_transport {
            tokio::select! {biased;
                _=self.cancelled()=>Err(ToolError::Execution("NATIVE_TRANSPORT_CANCELLED".into())),
                result=tokio::time::timeout(std::time::Duration::from_secs(5),authority.verify())=>
                    result.unwrap_or_else(|_|Err(ToolError::Execution("NATIVE_TRANSPORT_AUTHORITY_UNAVAILABLE".into())))
            }
        } else {
            Ok(())
        }
    }
}
