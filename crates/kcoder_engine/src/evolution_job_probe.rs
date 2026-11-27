//! Test support for hosts: hold a registration in the process-wide
//! self-evolution job registry so host tests can prove that their clear and
//! master-switch paths cancel real Engine jobs. Not used by production code.

use kcoder_types::evolution::{EvolutionJobKind, TargetKey};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

/// A registered stand-in job; dropping it unregisters the job, as a real
/// job does when it stops.
pub struct HeldEvolutionJob {
    _registration: crate::evolution::JobRegistration,
    pub token: CancellationToken,
}

/// Register a job that writes under `scope_root`.
pub fn hold_evolution_job(
    kind: EvolutionJobKind,
    target: Option<TargetKey>,
    scope_root: PathBuf,
) -> HeldEvolutionJob {
    let (registration, token) =
        crate::evolution::JobRegistration::register(kind, target, scope_root);
    HeldEvolutionJob {
        _registration: registration,
        token,
    }
}
