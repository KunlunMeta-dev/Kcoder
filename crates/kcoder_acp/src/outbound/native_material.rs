//! Ordered writes of already frozen input data; generic ACP hosts deny them.
use super::*;
use kcoder_types::integrations::core::{
    NATIVE_REMOTE_CONTROL_METHOD, NativeRemoteControlDataV1, NativeRemoteControlFrameV1,
};
struct MaterialGuard {
    host: Arc<dyn OutboundHost>,
    finished: bool,
}
impl Drop for MaterialGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.host.unknown_owned_native_material();
        }
    }
}
impl OutboundAcp {
    pub async fn write_owned_native_material(
        &mut self,
        request: &NativeRemoteControlFrameV1,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            self.initialized && !self.poisoned,
            "Original Native initialize required"
        );
        request.validate_shape().map_err(anyhow::Error::msg)?;
        ensure!(
            matches!(
                request.message,
                NativeRemoteControlDataV1::OfferMaterial(_)
                    | NativeRemoteControlDataV1::MaterialChunk(_)
                    | NativeRemoteControlDataV1::FinishMaterial(_)
            ),
            "Original material write required"
        );
        let params = serde_json::to_value(request)?;
        self.host.check_current()?;
        self.host.before_owned_native_material(&params)?;
        let mut guard = MaterialGuard {
            host: self.host.clone(),
            finished: false,
        };
        let (reply, _) = self
            .call(
                NATIVE_REMOTE_CONTROL_METHOD,
                params,
                None,
                cancel,
                Duration::from_secs(60),
            )
            .await?;
        self.host.check_current()?;
        guard.finished = true;
        Ok(reply)
    }
}
