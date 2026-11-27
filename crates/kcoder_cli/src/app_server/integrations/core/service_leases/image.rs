//! The running native image is captured from a kernel reference, not a caller path.
//! Windows retains a share-read-only handle, preventing writes or replacement while cached.
//! Linux cache hits verify device, inode, and size; same-inode, same-size in-place
//! rewrites are not detected without rehashing the executable bytes.
#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::Context;
use anyhow::Result;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use anyhow::ensure;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use std::time::Duration;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{fs::File, io::Read};
use tokio_util::sync::CancellationToken;

pub struct NativeServiceImage {
    #[cfg(windows)]
    windows: super::windows_image::WindowsServiceImage,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    file: File,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    identity: (u64, u64, u64),
    sha256: String,
}
impl NativeServiceImage {
    pub fn duplicate_handle(&self) -> Result<Self> {
        self.verify()?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            Ok(Self {
                file: self.file.try_clone()?,
                identity: self.identity,
                sha256: self.sha256.clone(),
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                windows: self.windows.duplicate()?,
                sha256: self.sha256.clone(),
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn capture(cancel: &CancellationToken) -> Result<Self> {
        image_cache().capture(cancel)
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn capture_uncached(cancel: &CancellationToken) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let mut file =
            File::open(native_image_path()?).context("SERVICE_NATIVE_IMAGE_UNAVAILABLE")?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() > 0 && metadata.len() <= 1024 * 1024 * 1024,
            "SERVICE_NATIVE_IMAGE_UNAVAILABLE"
        );
        let identity = (metadata.dev(), metadata.ino(), metadata.len());
        let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
        let mut buffer = [0u8; 65536];
        let mut total = 0u64;
        loop {
            ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .context("SERVICE_NATIVE_IMAGE_UNAVAILABLE")?;
            ensure!(total <= identity.2, "SERVICE_NATIVE_IMAGE_CHANGED");
            hash.update(&buffer[..count]);
        }
        ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
        ensure!(total == identity.2, "SERVICE_NATIVE_IMAGE_CHANGED");
        let sha256 = hash
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let image = Self {
            file,
            identity,
            sha256,
        };
        image.verify()?;
        Ok(image)
    }
    #[cfg(windows)]
    pub fn capture(cancel: &CancellationToken) -> Result<Self> {
        image_cache().capture(cancel)
    }
    #[cfg(windows)]
    fn capture_uncached(cancel: &CancellationToken) -> Result<Self> {
        use std::os::windows::io::BorrowedHandle;
        let process = unsafe {
            BorrowedHandle::borrow_raw(
                windows_sys::Win32::System::Threading::GetCurrentProcess().cast(),
            )
        };
        let windows = super::windows_image::WindowsServiceImage::capture(process, cancel)?;
        Ok(Self {
            sha256: windows.sha256().into(),
            windows,
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn capture(_cancel: &CancellationToken) -> Result<Self> {
        anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn verify(&self) -> Result<()> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.file.metadata()?;
            let actual = File::open(native_image_path()?)?.metadata()?;
            ensure!(
                (held.dev(), held.ino(), held.len()) == self.identity
                    && (actual.dev(), actual.ino(), actual.len()) == self.identity,
                "SERVICE_NATIVE_IMAGE_CHANGED"
            );
            Ok(())
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::BorrowedHandle;
            let process = unsafe {
                BorrowedHandle::borrow_raw(
                    windows_sys::Win32::System::Threading::GetCurrentProcess().cast(),
                )
            };
            self.windows.verify(process)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        anyhow::bail!("SERVICE_NATIVE_PLATFORM_UNSUPPORTED")
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[derive(Default)]
struct ImageCache {
    image: Mutex<Option<NativeServiceImage>>,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
impl ImageCache {
    fn capture(&self, cancel: &CancellationToken) -> Result<NativeServiceImage> {
        self.capture_with(cancel, NativeServiceImage::capture_uncached)
    }

    fn capture_with(
        &self,
        cancel: &CancellationToken,
        capture_uncached: impl FnOnce(&CancellationToken) -> Result<NativeServiceImage>,
    ) -> Result<NativeServiceImage> {
        let mut cached = self.lock(cancel)?;
        ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
        if let Some(image) = cached.as_ref() {
            image.verify()?;
            ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
            let duplicate = image.duplicate_handle()?;
            ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
            return Ok(duplicate);
        }

        let image = capture_uncached(cancel)?;
        ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
        let duplicate = image.duplicate_handle()?;
        ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
        *cached = Some(image);
        if cancel.is_cancelled() {
            *cached = None;
            anyhow::bail!("SERVICE_NATIVE_IMAGE_CANCELLED");
        }
        Ok(duplicate)
    }

    #[cfg(target_os = "linux")]
    fn cached_content_sha256_for_peer_identity(
        &self,
        peer_identity: (u64, u64, u64),
    ) -> Result<Option<String>> {
        let cached = match self.image.try_lock() {
            Ok(cached) => cached,
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Poisoned(_)) => {
                anyhow::bail!("SERVICE_NATIVE_IMAGE_CACHE_POISONED")
            }
        };
        let Some(image) = cached.as_ref() else {
            return Ok(None);
        };

        // A cached digest is content metadata only. Verify the held self image
        // before comparing identities; invalid cache state must fail closed.
        image.verify()?;
        if image.identity == peer_identity {
            Ok(Some(image.sha256.clone()))
        } else {
            Ok(None)
        }
    }

    fn lock(
        &self,
        cancel: &CancellationToken,
    ) -> Result<MutexGuard<'_, Option<NativeServiceImage>>> {
        loop {
            ensure!(!cancel.is_cancelled(), "SERVICE_NATIVE_IMAGE_CANCELLED");
            match self.image.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::WouldBlock) => {
                    // Recheck cancellation every 5 ms; scheduler delay can extend the wait.
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TryLockError::Poisoned(_)) => {
                    anyhow::bail!("SERVICE_NATIVE_IMAGE_CACHE_POISONED")
                }
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
static IMAGE_CACHE: OnceLock<ImageCache> = OnceLock::new();

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn image_cache() -> &'static ImageCache {
    IMAGE_CACHE.get_or_init(ImageCache::default)
}

#[cfg(target_os = "linux")]
pub(super) fn cached_content_sha256_for_peer_identity(
    peer_identity: (u64, u64, u64),
) -> Result<Option<String>> {
    image_cache().cached_content_sha256_for_peer_identity(peer_identity)
}

#[cfg(all(target_os = "linux", test))]
#[path = "image_tests.rs"]
mod tests;

#[cfg(all(windows, test))]
mod windows_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn repeated_self_capture_reuses_the_held_verified_image() {
        let cache = ImageCache::default();
        let cancel = CancellationToken::new();
        let captures = AtomicUsize::new(0);
        let first = cache
            .capture_with(&cancel, |cancel| {
                captures.fetch_add(1, Ordering::SeqCst);
                NativeServiceImage::capture_uncached(cancel)
            })
            .unwrap();
        let second = cache
            .capture_with(&cancel, |_| {
                panic!("the held Windows image must not be rehashed")
            })
            .unwrap();
        first.verify().unwrap();
        second.verify().unwrap();
        assert_eq!(first.sha256(), second.sha256());
        assert_eq!(captures.load(Ordering::SeqCst), 1);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_image_path() -> Result<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        Ok("/proc/self/exe".into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(std::env::current_exe()?)
    }
}
