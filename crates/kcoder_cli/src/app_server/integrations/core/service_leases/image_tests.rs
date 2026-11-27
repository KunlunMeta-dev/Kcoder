use super::{ImageCache, NativeServiceImage};
use std::fs::File;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn test_image() -> NativeServiceImage {
    use std::os::unix::fs::MetadataExt;

    let file = File::open("/proc/self/exe").expect("open test process image");
    let metadata = file.metadata().expect("test process metadata");
    NativeServiceImage {
        file,
        identity: (metadata.dev(), metadata.ino(), metadata.len()),
        sha256: "test-only-image".into(),
    }
}

#[test]
fn repeated_local_capture_hashes_the_running_image_once() {
    let cache = ImageCache::default();
    let cancel = CancellationToken::new();
    let hash_passes = AtomicUsize::new(0);

    let first = cache
        .capture_with(&cancel, |cancel| {
            hash_passes.fetch_add(1, Ordering::SeqCst);
            NativeServiceImage::capture_uncached(cancel)
        })
        .expect("first uncached capture");
    let second = cache
        .capture_with(&cancel, |cancel| {
            hash_passes.fetch_add(1, Ordering::SeqCst);
            NativeServiceImage::capture_uncached(cancel)
        })
        .expect("second cached capture");

    assert_eq!(first.sha256(), second.sha256());
    assert_eq!(hash_passes.load(Ordering::SeqCst), 1);
}

#[test]
fn global_capture_interface_returns_independent_verified_handles() {
    use std::os::fd::AsRawFd;

    let cancel = CancellationToken::new();
    let first = NativeServiceImage::capture(&cancel).expect("first process image capture");
    let second = NativeServiceImage::capture(&cancel).expect("second process image capture");

    assert_eq!(first.sha256(), second.sha256());
    assert_ne!(first.file.as_raw_fd(), second.file.as_raw_fd());
    first.verify().expect("first handle remains valid");
    second.verify().expect("second handle remains valid");
}

#[test]
fn cancelled_cache_hit_returns_cancelled_and_preserves_cached_image() {
    let cache = ImageCache::default();
    cache
        .image
        .lock()
        .expect("cache lock")
        .replace(test_image());

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = cache
        .capture_with(&cancelled, |_| panic!("cancelled hit must not capture"))
        .err()
        .expect("cancelled hit must fail");
    assert!(error.to_string().contains("SERVICE_NATIVE_IMAGE_CANCELLED"));
    assert!(cache.image.lock().expect("cache lock").is_some());

    let hit = cache
        .capture_with(&CancellationToken::new(), |_| {
            panic!("cache hit must not recapture")
        })
        .expect("cached image remains usable");
    assert_eq!(hit.sha256(), "test-only-image");
}

#[test]
fn failed_or_cancelled_misses_do_not_populate_the_cache() {
    let cache = ImageCache::default();
    let called = AtomicBool::new(false);
    let error = cache
        .capture_with(&CancellationToken::new(), |_| {
            called.store(true, Ordering::SeqCst);
            anyhow::bail!("expected first-capture failure")
        })
        .err()
        .expect("failed first capture");
    assert!(error.to_string().contains("expected first-capture failure"));
    assert!(called.load(Ordering::SeqCst));
    assert!(cache.image.lock().expect("cache lock").is_none());

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    called.store(false, Ordering::SeqCst);
    let error = cache
        .capture_with(&cancelled, |_| {
            called.store(true, Ordering::SeqCst);
            Ok(test_image())
        })
        .err()
        .expect("cancelled first capture");
    assert!(error.to_string().contains("SERVICE_NATIVE_IMAGE_CANCELLED"));
    assert!(!called.load(Ordering::SeqCst));
    assert!(cache.image.lock().expect("cache lock").is_none());

    let cancelled_during_capture = CancellationToken::new();
    called.store(false, Ordering::SeqCst);
    let error = cache
        .capture_with(&cancelled_during_capture, |cancel| {
            called.store(true, Ordering::SeqCst);
            cancel.cancel();
            Ok(test_image())
        })
        .err()
        .expect("capture cancelled before cache commit");
    assert!(error.to_string().contains("SERVICE_NATIVE_IMAGE_CANCELLED"));
    assert!(called.load(Ordering::SeqCst));
    assert!(cache.image.lock().expect("cache lock").is_none());

    cache
        .capture_with(&CancellationToken::new(), |_| Ok(test_image()))
        .expect("later successful capture");
    assert!(cache.image.lock().expect("cache lock").is_some());
}

#[test]
fn cached_identity_failure_fails_closed_without_rehashing() {
    let cache = ImageCache::default();
    cache
        .image
        .lock()
        .expect("cache lock")
        .replace(test_image());
    {
        let mut image = cache.image.lock().expect("cache lock");
        let image = image.as_mut().expect("cached image");
        image.identity.1 = image.identity.1.wrapping_add(1);
    }
    let recapture_called = AtomicBool::new(false);

    let error = cache
        .capture_with(&CancellationToken::new(), |_| {
            recapture_called.store(true, Ordering::SeqCst);
            Ok(test_image())
        })
        .err()
        .expect("invalid cached identity must fail closed");

    assert!(error.to_string().contains("SERVICE_NATIVE_IMAGE_CHANGED"));
    assert!(!recapture_called.load(Ordering::SeqCst));
    assert!(cache.image.lock().expect("cache lock").is_some());
}

#[test]
fn cache_hits_duplicate_the_cached_handle() {
    use std::os::fd::AsRawFd;

    let cache = ImageCache::default();
    cache
        .image
        .lock()
        .expect("cache lock")
        .replace(test_image());
    let cancel = CancellationToken::new();
    let first = cache
        .capture_with(&cancel, |_| panic!("first cached read must not recapture"))
        .expect("first cached handle");
    let second = cache
        .capture_with(&cancel, |_| panic!("second cached read must not recapture"))
        .expect("second cached handle");

    assert_ne!(first.file.as_raw_fd(), second.file.as_raw_fd());
    drop(first);
    second
        .verify()
        .expect("second descriptor survives first close");
}

#[test]
fn cancellation_is_observed_while_waiting_for_the_cache_mutex() {
    let cache = Arc::new(ImageCache::default());
    let cancel = CancellationToken::new();
    let guard = cache.image.lock().expect("hold cache lock");
    let waiter_cache = Arc::clone(&cache);
    let waiter_cancel = cancel.clone();
    let capture_called = Arc::new(AtomicBool::new(false));
    let waiter_capture_called = Arc::clone(&capture_called);
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        started_tx.send(()).expect("signal waiter start");
        let result = waiter_cache.capture_with(&waiter_cancel, |_| {
            waiter_capture_called.store(true, Ordering::SeqCst);
            anyhow::bail!("uncached capture must not start while lock is held")
        });
        result_tx.send(result.map(|_| ()).map_err(|error| error.to_string()))
    });

    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("waiter started");
    thread::sleep(Duration::from_millis(20));
    cancel.cancel();
    let result = result_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("cancelled waiter returns while the mutex is still held");
    assert!(
        result
            .expect_err("cancelled lock wait")
            .contains("SERVICE_NATIVE_IMAGE_CANCELLED")
    );
    waiter.join().expect("join waiter").expect("send result");
    assert!(!capture_called.load(Ordering::SeqCst));
    drop(guard);
}

#[test]
fn peer_digest_lookup_reuses_only_a_verified_matching_self_identity() {
    let cache = ImageCache::default();
    cache
        .image
        .lock()
        .expect("cache lock")
        .replace(test_image());
    let identity = cache
        .image
        .lock()
        .expect("cache lock")
        .as_ref()
        .expect("cached image")
        .identity;

    assert_eq!(
        cache
            .cached_content_sha256_for_peer_identity(identity)
            .expect("matching verified self identity"),
        Some("test-only-image".into())
    );
    for different_identity in [
        (identity.0.wrapping_add(1), identity.1, identity.2),
        (identity.0, identity.1.wrapping_add(1), identity.2),
        (identity.0, identity.1, identity.2.wrapping_add(1)),
    ] {
        assert_eq!(
            cache
                .cached_content_sha256_for_peer_identity(different_identity)
                .expect("different peer identity is a cache miss"),
            None
        );
    }
}

#[test]
fn peer_digest_lookup_misses_when_cache_is_empty_or_busy() {
    let empty = ImageCache::default();
    assert_eq!(
        empty
            .cached_content_sha256_for_peer_identity((1, 2, 3))
            .expect("empty cache is a miss"),
        None
    );

    let busy = ImageCache::default();
    busy.image.lock().expect("cache lock").replace(test_image());
    let guard = busy.image.lock().expect("hold cache lock");
    assert_eq!(
        busy.cached_content_sha256_for_peer_identity((1, 2, 3))
            .expect("busy cache is a miss"),
        None
    );
    drop(guard);
}

#[test]
fn peer_digest_lookup_fails_closed_for_invalid_or_poisoned_self_cache() {
    let invalid = ImageCache::default();
    invalid
        .image
        .lock()
        .expect("cache lock")
        .replace(test_image());
    {
        let mut image = invalid.image.lock().expect("cache lock");
        image.as_mut().expect("cached image").identity.1 = 0;
    }
    let error = invalid
        .cached_content_sha256_for_peer_identity((0, 0, 0))
        .expect_err("invalid self cache must fail closed before peer comparison");
    assert!(error.to_string().contains("SERVICE_NATIVE_IMAGE_CHANGED"));

    let poisoned = Arc::new(ImageCache::default());
    let poisoner = Arc::clone(&poisoned);
    let join = thread::spawn(move || {
        let _guard = poisoner.image.lock().expect("cache lock");
        panic!("poison local cache for regression test");
    });
    assert!(join.join().is_err());
    let error = poisoned
        .cached_content_sha256_for_peer_identity((1, 2, 3))
        .expect_err("poisoned cache must fail closed");
    assert!(
        error
            .to_string()
            .contains("SERVICE_NATIVE_IMAGE_CACHE_POISONED")
    );
}
