//! Every original public RPC uses the same bounded host queue.
use super::*;
use crate::app_server::rpc_connection::RpcRequest;

impl NativeRuntimeClient {
    pub(in crate::app_server) fn rpc_hub(&self) -> crate::app_server::rpc_hub::RpcHub {
        self.rpc_hub.clone()
    }
    pub(in crate::app_server) fn rpc(
        &self,
        request: RpcRequest,
    ) -> std::result::Result<(), Box<RpcRequest>> {
        match self
            .sender
            .try_send(Control::RpcConnection(Box::new(request)))
        {
            Ok(()) => Ok(()),
            Err(error) => match error.into_inner() {
                Control::RpcConnection(request) => Err(request),
                _ => unreachable!("only the original RPC request was enqueued"),
            },
        }
    }
}
impl NativeRuntimePump {
    pub(in crate::app_server) fn next_rpc_request(&mut self) -> Option<RpcRequest> {
        self.rpc_requests.pop_front().map(|request| {
            *request
                .into_inner()
                .unwrap_or_else(|error| error.into_inner())
        })
    }
    pub(in crate::app_server) fn rpc_hub(&self) -> crate::app_server::rpc_hub::RpcHub {
        self.rpc_hub.clone()
    }
}
