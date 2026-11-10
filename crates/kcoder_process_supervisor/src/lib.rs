#[cfg(feature = "async-process")]
pub mod owned_process;

pub mod protocol;

#[cfg(target_os = "linux")]
pub mod linux_stdio;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(windows)]
pub mod client;

#[cfg(windows)]
pub mod windows;

#[cfg(windows)]
pub mod suspended_child;

#[cfg(windows)]
mod windows_cleanup_receipt;

#[cfg(all(windows, feature = "native-image-addon"))]
mod native_image;
