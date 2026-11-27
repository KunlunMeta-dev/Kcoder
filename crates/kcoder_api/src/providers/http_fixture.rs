//! Bounded loopback HTTP helpers; no credentials or external services.
use std::time::Duration;
use tokio::{io::AsyncReadExt, net::TcpStream, task::JoinHandle};

pub(crate) async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let length = socket.read(&mut chunk).await.expect("local request read");
            assert!(
                length > 0,
                "client closed before its complete fixture request"
            );
            request.extend_from_slice(&chunk[..length]);
            assert!(request.len() <= 256 * 1024, "bounded fixture request");
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end]).unwrap();
                assert!(
                    !headers
                        .lines()
                        .any(|line| line.to_ascii_lowercase().starts_with("transfer-encoding:")),
                    "fixture expects a fixed-size JSON request"
                );
                let body = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                assert!(body <= 256 * 1024, "bounded fixture body");
                if request.len() >= end + 4 + body {
                    return request;
                }
            }
        }
    })
    .await
    .expect("bounded local request deadline")
}

pub(crate) async fn join(mut server: JoinHandle<()>) {
    match tokio::time::timeout(Duration::from_secs(4), &mut server).await {
        Ok(result) => result.unwrap(),
        Err(_) => {
            server.abort();
            let _ = server.await;
            panic!("bounded local fixture completion");
        }
    }
}

#[tokio::test]
async fn fragmented_fixture_request_waits_for_the_complete_declared_body() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (send, mut done) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        send.send(request).unwrap();
    });
    let mut client = TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"POST /fixture HTTP/1.1\r\nContent-Length: 8\r\n\r\n1234")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut done)
            .await
            .is_err()
    );
    client.write_all(b"5678").await.unwrap();
    let request = tokio::time::timeout(Duration::from_secs(3), done)
        .await
        .unwrap()
        .unwrap();
    assert!(request.ends_with(b"12345678"));
    join(server).await;
}
