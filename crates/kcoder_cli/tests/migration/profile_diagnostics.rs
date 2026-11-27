//! Own and drain only this fixture's diagnostics; never print arbitrary server log contents.
use super::TestAppServer;
use std::{
    io::Read,
    ops::{Deref, DerefMut},
    thread::JoinHandle,
};

pub(super) struct ObservedServer {
    server: Option<TestAppServer>,
    diagnostics: Option<JoinHandle<Vec<&'static str>>>,
}
impl ObservedServer {
    pub(super) fn new(mut server: TestAppServer) -> Self {
        let mut stderr = server.child.stderr.take().expect("owned fixture stderr");
        let diagnostics = std::thread::spawn(move || {
            let mut chunk = [0; 4096];
            let mut bytes = Vec::new();
            while let Ok(length) = stderr.read(&mut chunk) {
                if length == 0 {
                    break;
                }
                let retained = length.min((64 * 1024usize).saturating_sub(bytes.len()));
                bytes.extend_from_slice(&chunk[..retained]);
            }
            let text = String::from_utf8_lossy(&bytes);
            [
                "journal_read",
                "journal_write",
                "batch_runner",
                "credential_operation",
            ]
            .into_iter()
            .filter(|label| text.contains(label))
            .collect()
        });
        Self {
            server: Some(server),
            diagnostics: Some(diagnostics),
        }
    }
    pub(super) fn shutdown(mut self) {
        self.server.take().unwrap().shutdown();
    }
}
impl Deref for ObservedServer {
    type Target = TestAppServer;
    fn deref(&self) -> &Self::Target {
        self.server.as_ref().unwrap()
    }
}
impl DerefMut for ObservedServer {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.server.as_mut().unwrap()
    }
}
impl Drop for ObservedServer {
    fn drop(&mut self) {
        drop(self.server.take());
        if let Some(reader) = self.diagnostics.take() {
            for lease in reader.join().unwrap_or_default() {
                eprintln!("owned migration fixture contention: lease={lease}");
            }
        }
    }
}
