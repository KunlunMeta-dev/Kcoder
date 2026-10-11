//! Owned loopback pipe probe. No desktop observation or input.
#[cfg(windows)]
#[tokio::main]
async fn main() {
    use kcoder_computer_use::windows_peer::{PeerError, PipePeer, verify_pipe_peer};
    use std::os::windows::io::AsHandle;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
    let name = format!(r"\\.\pipe\kcoder-peer-probe-{}", uuid::Uuid::new_v4());
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&name)
        .unwrap();
    let client = ClientOptions::new().open(&name).unwrap();
    server.connect().await.unwrap();
    let result = verify_pipe_peer(server.as_handle(), PipePeer::Client);
    let expected = std::env::args().nth(1).unwrap_or_else(|| "session0".into());
    if expected == "session0" {
        assert!(matches!(result, Err(PeerError::DifferentSession)));
        assert!(matches!(
            verify_pipe_peer(client.as_handle(), PipePeer::Server),
            Err(PeerError::DifferentSession)
        ));
        println!("PASS: both pipe endpoints reject Session 0");
    } else {
        let peer = result.expect("interactive same-user peer");
        assert_eq!(peer.process_id, std::process::id());
        assert!(peer.session_id > 0);
        let server_peer = verify_pipe_peer(client.as_handle(), PipePeer::Server).unwrap();
        assert_eq!(server_peer.session_id, peer.session_id);
        println!("PASS: same-user interactive pipe peers");
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only probe");
    std::process::exit(2);
}
