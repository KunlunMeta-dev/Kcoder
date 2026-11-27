//! Executable-image file identity primitives shared by the Windows Native
//! addon (`kcoder_native_image`), Native service leases and remote delegation
//! transport.
//!
//! These are observations only. Each caller keeps its own error codes,
//! size/link policy, PE and ACL rules, cancellation and authority decisions;
//! nothing here grants execution, task or route authority or caches a verdict.
mod digest;
pub use digest::{HashFailure, ImageDigest, sha256_bounded};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{FileInformation, file_information, open_share_read, process_image_path};
