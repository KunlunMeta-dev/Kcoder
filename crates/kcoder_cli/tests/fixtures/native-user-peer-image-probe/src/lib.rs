//! Linux kernel-peer regression using the actual production lease modules.
#![cfg(target_os = "linux")]
#[path = "../../../../src/app_server/integrations/core/service_leases/image.rs"]
#[allow(dead_code)]
mod image;
#[path = "../../../../src/app_server/integrations/core/service_leases/user_peer.rs"]
#[allow(dead_code)]
mod user_peer;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use tokio_util::sync::CancellationToken;

    fn read_bytes() -> u64 {
        std::fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("rchar: ")
                    .map(|value| value.trim().parse().unwrap())
            })
            .unwrap()
    }

    #[test]
    fn warm_connections_to_the_same_kernel_image_do_not_reread_executable_bytes() {
        let expected = image::NativeServiceImage::capture(&CancellationToken::new()).unwrap();
        let before = read_bytes();
        for _ in 0..16 {
            let (socket, _other) = UnixStream::pair().unwrap();
            let peer =
                user_peer::NativeUserServicePeer::capture(&socket, expected.sha256()).unwrap();
            assert_eq!(peer.held_pid().unwrap(), std::process::id());
            peer.verify().unwrap();
        }
        let consumed = read_bytes() - before;
        println!("warm_peer_connections=16 read_bytes={consumed}");
        assert!(
            consumed < 64 * 1024,
            "warm peers must not re-read the executable: {consumed} bytes"
        );
        let (socket, _other) = UnixStream::pair().unwrap();
        assert!(
            user_peer::NativeUserServicePeer::capture(&socket, &"0".repeat(64)).is_err(),
            "same image does not waive the expected digest check"
        );
    }
}
