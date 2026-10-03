//! CLI startup domains. State ownership and entry ordering remain in runtime wiring.

use super::*;

mod runtime_wiring;
pub(super) use runtime_wiring::*;

mod entry_modes;
pub(super) use entry_modes::*;

mod settings_overrides;
pub(super) use settings_overrides::*;

mod credentials;
pub(super) use credentials::*;

mod extension_preflight;
pub(super) use extension_preflight::*;
