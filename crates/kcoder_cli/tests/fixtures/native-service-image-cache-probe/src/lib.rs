//! Linux-only small harness that compiles the production native image and peer modules.
#![cfg(target_os = "linux")]

#[path = "../../../../src/app_server/integrations/core/service_leases/image.rs"]
#[allow(dead_code)]
// The isolated fixture exercises only the production image module's parent-visible surface.
mod image;

#[path = "../../../../src/app_server/integrations/core/service_leases/user_peer.rs"]
#[allow(dead_code)]
// The fixture exercises the real same-UID OS-peer and process-image checks.
mod user_peer;
