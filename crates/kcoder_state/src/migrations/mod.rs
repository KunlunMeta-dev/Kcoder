//! Format-specific migrations. Readers validate without upgrading stored data;
//! the existing session owner publishes upgrades under its persistence lock.

pub(crate) mod sessions;
