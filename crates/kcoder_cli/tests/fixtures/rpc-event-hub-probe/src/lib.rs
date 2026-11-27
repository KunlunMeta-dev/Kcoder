#![allow(dead_code)]
//! Imports the production event router; fixture constructors supply wire frames only.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","method":method,"params":params})
}
fn success_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

#[path = "../../../../src/app_server/rpc_hub.rs"]
mod rpc_hub;

// Keep the production hierarchy so scoped visibility and framing stay identical.
#[path = "."]
mod app_server {
    #[path = "../../../../src/app_server/protocol_io.rs"]
    mod protocol_io;
    #[path = "."]
    mod integrations {
        #[path = "."]
        mod connectivity {
            #[path = "../../../../src/app_server/integrations/connectivity/host_rpc.rs"]
            mod host_rpc;
        }
    }
}
