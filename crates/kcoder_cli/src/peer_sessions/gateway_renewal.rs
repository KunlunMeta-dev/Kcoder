//! Credential maintenance belongs to the original live runtime, never a model job.
use super::{
    BoundPeerSource,
    gateway_auth::{DeviceAuthorizationRejected, DeviceEnrollmentChanged, GatewayDeviceClient},
    gateway_channel::GatewayPeerChannel,
};
use std::{
    sync::{Arc, Weak},
    time::Duration,
};

pub(super) fn start(
    mut client: GatewayDeviceClient,
    source: Weak<BoundPeerSource>,
    channel: Arc<GatewayPeerChannel>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let cancel = channel.cancellation();
        let mut retry = None;
        loop {
            let delay = retry.unwrap_or_else(|| client.refresh_delay());
            tokio::select! {biased;_=cancel.cancelled()=>break,_=tokio::time::sleep(delay)=>{}}
            let Some(owner) = source.upgrade() else {
                channel.close();
                break;
            };
            if owner.check_owner().is_err() {
                channel.close();
                break;
            }
            // Cancellation may lose an HTTP receipt. rotate() already persisted
            // the original rotation ID before dispatch, so the next real owner
            // reconciles that exact operation rather than starting a new one.
            let result = tokio::select! {biased;_=cancel.cancelled()=>break,result=client.refresh_if_due()=>result};
            if owner.check_owner().is_err() {
                channel.close();
                break;
            }
            match result {
                Ok(_) => retry = None,
                Err(error)
                    if error.is::<DeviceAuthorizationRejected>()
                        || error.is::<DeviceEnrollmentChanged>() =>
                {
                    channel.close();
                    break;
                }
                Err(_) => {
                    // Another local owner may hold the shared credential lock,
                    // or the original refresh receipt may be unknown. No body,
                    // URL, credentials or error chain enters model/UI context.
                    retry = Some(retry.map_or(Duration::from_secs(5), |previous: Duration| {
                        (previous * 2).min(Duration::from_secs(30))
                    }));
                }
            }
        }
    })
}
