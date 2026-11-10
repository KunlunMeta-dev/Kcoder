//! Serialize one process's calls to the original issuer's nonblocking OS lock.
//! Reuse the held issuer; never cache an authorization decision.
use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use kcoder_native_delegation::NativeDelegationAuthority;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
pub(super) struct Gate {
    serial: Mutex<()>,
    pub(super) authority: OnceLock<Arc<NativeDelegationAuthority>>,
}
impl Gate {
    pub(super) fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, ()>> {
        self.serial.lock()
    }
}
static GATES: OnceLock<Mutex<BTreeMap<String, Arc<Gate>>>> = OnceLock::new();
pub(super) fn for_directory(directory: &PrivateDirectory) -> Result<Arc<Gate>> {
    directory.verify_private_directory()?;
    let identity = directory.directory_identity()?;
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("DELEGATION_PROCESS_GATE_UNAVAILABLE"))?;
    if let Some(gate) = gates.get(&identity) {
        return Ok(gate.clone());
    }
    if gates.len() >= 128 {
        let idle = gates
            .iter()
            .find(|(_, gate)| Arc::strong_count(gate) == 1)
            .map(|(identity, _)| identity.clone())
            .context("DELEGATION_PROCESS_GATE_CAPACITY")?;
        gates.remove(&idle);
    }
    let gate = Arc::new(Gate {
        serial: Mutex::new(()),
        authority: OnceLock::new(),
    });
    directory
        .verify_private_directory()
        .context("DELEGATION_PROCESS_GATE_OWNER_CHANGED")?;
    // Retain the verified issuer across sequential operations. The issuer
    // still reads the current locked journal and computes authorization anew.
    gates.insert(identity, gate.clone());
    Ok(gate)
}
