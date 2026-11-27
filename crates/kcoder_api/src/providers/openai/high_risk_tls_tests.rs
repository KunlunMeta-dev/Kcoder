use super::*;
use std::process::Command;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_rustls::{TlsAcceptor, rustls};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn headers(stream: &mut (impl AsyncRead + Unpin)) -> std::io::Result<()> {
    let mut bytes = [0; 8192];
    let mut used = 0;
    loop {
        let count = stream.read(&mut bytes[used..]).await?;
        if count == 0 || used + count == bytes.len() {
            return Err(std::io::Error::other("bounded fixture headers unavailable"));
        }
        used += count;
        if bytes[..used].windows(4).any(|part| part == b"\r\n\r\n") {
            return Ok(());
        }
    }
}

#[test]
fn native_provider_accepts_a_declared_machine_ca_but_rejects_an_untrusted_peer() {
    const CHILD_PROXY: &str = "KCODER_TEST_NATIVE_ROOT_PROXY";
    if let Ok(proxy) = std::env::var(CHILD_PROXY) {
        let expected = std::env::var("KCODER_TEST_NATIVE_ROOT_EXPECT").unwrap() == "trusted";
        runtime().block_on(async {
            let provider = OpenAiProvider::new("inert-fixture", "inert-model")
                .unwrap()
                .with_proxy_url(Some(proxy))
                .unwrap();
            let result = provider
                .client
                .get("https://compat.example/native-ca-fixture")
                .timeout(Duration::from_secs(3))
                .send()
                .await;
            assert_eq!(result.is_ok(), expected, "{result:?}");
            if expected {
                assert_eq!(result.unwrap().text().await.unwrap(), "OK");
            }
        });
        return;
    }

    let owned = tempfile::tempdir().unwrap();
    let certificate_file = owned.path().join("synthetic-ca.pem");
    std::fs::write(
        &certificate_file,
        include_bytes!("../anthropic/fixtures/loopback-cert.pem"),
    )
    .unwrap();
    let empty_file = owned.path().join("untrusted.pem");
    std::fs::write(&empty_file, []).unwrap();
    let empty_directory = owned.path().join("empty-roots");
    std::fs::create_dir(&empty_directory).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        runtime().block_on(async {
            let certificate = include_bytes!("../anthropic/fixtures/loopback-cert.der").to_vec();
            let key = include_bytes!("../anthropic/fixtures/loopback-key.der").to_vec();
            let config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![rustls::pki_types::CertificateDer::from(certificate)],
                rustls::pki_types::PrivateKeyDer::try_from(key).unwrap(),
            )
            .unwrap();
            let acceptor = TlsAcceptor::from(std::sync::Arc::new(config));
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            for _ in 0..2 {
                let exchange = async {
                    let (mut stream, _) = listener.accept().await?;
                    headers(&mut stream).await?;
                    stream
                        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        .await?;
                    let mut stream = acceptor.accept(stream).await?;
                    headers(&mut stream).await?;
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                        )
                        .await?;
                    stream.shutdown().await
                };
                let _ = tokio::time::timeout(Duration::from_secs(10), exchange).await;
            }
        });
    });
    let name = concat!(
        module_path!(),
        "::native_provider_accepts_a_declared_machine_ca_but_rejects_an_untrusted_peer"
    );
    let name = name.split_once("::").unwrap().1;
    let outputs: Vec<_> = [("trusted", certificate_file), ("untrusted", empty_file)]
        .into_iter()
        .map(|(expected, file)| {
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", name, "--nocapture"])
                .env(CHILD_PROXY, format!("http://{address}"))
                .env("KCODER_TEST_NATIVE_ROOT_EXPECT", expected)
                .env("SSL_CERT_FILE", file)
                .env("SSL_CERT_DIR", &empty_directory)
                .output()
        })
        .collect();
    server.join().unwrap();
    for output in outputs {
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
