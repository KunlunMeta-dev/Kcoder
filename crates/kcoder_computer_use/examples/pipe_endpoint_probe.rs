//! Creates an owned ACL-protected endpoint and tests Session-0 rejection.
//! Does not initialize a desktop worker or inject input.
#[cfg(windows)]
#[tokio::main]
async fn main() {
    use kcoder_computer_use::{
        admission::Admissions,
        broker::DesktopBroker,
        windows_pipe::PipeEndpoint,
        worker::{DesktopWorker, WorkerError, WorkerHandle},
    };
    use std::{sync::Arc, time::Duration};
    struct Unused;
    #[async_trait::async_trait]
    impl DesktopWorker for Unused {
        async fn call(
            &mut self,
            _: &str,
            _: serde_json::Value,
        ) -> Result<serde_json::Value, WorkerError> {
            panic!("unauthorized worker call")
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            Ok(())
        }
    }
    let endpoint = PipeEndpoint::create().unwrap();
    let name = endpoint.name().to_owned();
    let broker =
        DesktopBroker::new(WorkerHandle::spawn(Unused, Duration::from_secs(1)), 3).unwrap();
    let server = tokio::spawn(endpoint.serve_once(
        Arc::new(tokio::sync::Mutex::new(Admissions::default())),
        broker,
    ));
    let _client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&name)
        .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("peer rejected"), "{error}");
    println!("PASS: explicit user DACL endpoint created; Session 0 rejected before grant parsing");
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(2);
}
