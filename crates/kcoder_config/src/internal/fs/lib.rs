//! Private filesystem handles and permissions, independent of configuration and sessions.
#[doc(hidden)]
#[path = "file_permissions.rs"]
pub mod file_permissions;
#[path = "private_files.rs"]
pub mod private_files;
#[cfg(windows)]
pub use file_permissions::set_and_verify_windows_user_only_handle;
pub use file_permissions::{
    is_user_only_file, set_user_only_dir_permissions, set_user_only_file_permissions,
};
pub use private_files::*;
