use super::ChildOwner;
use portable_pty::{Child, ChildKiller, ExitStatus};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Debug)]
struct ChildState {
    live: AtomicBool,
    kills: AtomicUsize,
    waits: AtomicUsize,
}

#[derive(Debug)]
struct FakeChild(Arc<ChildState>);

impl ChildKiller for FakeChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.kills.fetch_add(1, Ordering::SeqCst);
        self.0.live.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self(self.0.clone()))
    }
}

impl Child for FakeChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        Ok((!self.0.live.load(Ordering::SeqCst)).then(|| ExitStatus::with_exit_code(0)))
    }
    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.0.waits.fetch_add(1, Ordering::SeqCst);
        self.try_wait()?
            .ok_or_else(|| std::io::Error::other("fake child is still live"))
    }
    fn process_id(&self) -> Option<u32> {
        None
    }
    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

fn state(live: bool) -> Arc<ChildState> {
    Arc::new(ChildState {
        live: AtomicBool::new(live),
        kills: AtomicUsize::new(0),
        waits: AtomicUsize::new(0),
    })
}

#[test]
fn unpublished_child_is_killed_and_reaped_when_setup_returns_early() {
    let child = state(true);
    drop(ChildOwner::new(Box::new(FakeChild(child.clone()))));
    assert!(!child.live.load(Ordering::SeqCst));
    assert_eq!(child.kills.load(Ordering::SeqCst), 1);
    assert_eq!(child.waits.load(Ordering::SeqCst), 1);
}

#[test]
fn already_reaped_child_is_never_signalled_again() {
    let child = state(false);
    drop(ChildOwner::new(Box::new(FakeChild(child.clone()))));
    assert_eq!(child.kills.load(Ordering::SeqCst), 0);
    assert_eq!(child.waits.load(Ordering::SeqCst), 0);
}

#[test]
fn output_eof_waits_for_the_actual_process_exit_before_cleanup() {
    let child = state(true);
    std::thread::scope(|scope| {
        let exiting = child.clone();
        scope.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            exiting.live.store(false, Ordering::SeqCst);
        });
        let mut owner = ChildOwner::new(Box::new(FakeChild(child.clone())));
        let status = owner
            .observe_exit_for(std::time::Duration::from_secs(1))
            .unwrap()
            .expect("the process naturally exited after output EOF");
        assert_eq!(status.exit_code(), 0);
    });
    assert_eq!(child.kills.load(Ordering::SeqCst), 0);
    assert_eq!(child.waits.load(Ordering::SeqCst), 0);
}

#[test]
fn output_eof_timeout_keeps_the_live_child_owned_for_cleanup() {
    let child = state(true);
    let mut owner = ChildOwner::new(Box::new(FakeChild(child.clone())));
    assert!(
        owner
            .observe_exit_for(std::time::Duration::ZERO)
            .unwrap()
            .is_none()
    );
    assert!(child.live.load(Ordering::SeqCst));
    assert_eq!(child.kills.load(Ordering::SeqCst), 0);
    drop(owner);
    assert_eq!(child.kills.load(Ordering::SeqCst), 1);
    assert_eq!(child.waits.load(Ordering::SeqCst), 1);
}

#[cfg(windows)]
#[test]
fn exited_child_releases_console_without_any_reader_eof() {
    use super::super::{TerminalSession, TerminalState};
    use std::{
        collections::VecDeque,
        sync::{Mutex, mpsc},
        time::Duration,
    };
    struct Console(mpsc::Sender<()>);
    impl Drop for Console {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    impl portable_pty::MasterPty for Console {
        fn resize(&self, _: portable_pty::PtySize) -> anyhow::Result<()> {
            Ok(())
        }
        fn get_size(&self) -> anyhow::Result<portable_pty::PtySize> {
            Ok(portable_pty::PtySize::default())
        }
        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
            anyhow::bail!("no reader in this lifecycle test")
        }
        fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
            anyhow::bail!("no writer in this lifecycle test")
        }
    }
    let (send, receive) = mpsc::channel();
    let child = state(false);
    let session = Arc::new(TerminalSession {
        master: Mutex::new(Some(Box::new(Console(send)))),
        input_tx: Mutex::new(None),
        child: Mutex::new(ChildOwner::new(Box::new(FakeChild(child.clone())))),
        state: Mutex::new(TerminalState {
            cwd: String::new(),
            rows: 24,
            cols: 80,
            transcript: VecDeque::new(),
            transcript_bytes: 0,
            sequence: 0,
            truncated: false,
        }),
        closed: AtomicBool::new(false),
        process_exited: AtomicBool::new(false),
        exit_notified: AtomicBool::new(false),
        console_closed: AtomicBool::new(false),
        output_drained: AtomicBool::new(false),
    });
    super::watch_child(
        session.clone(),
        1,
        super::super::TerminalRegistry::default(),
        "fixture".into(),
    )
    .unwrap();
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    super::wait_console_closed(&session).unwrap();
    assert!(session.closed.load(Ordering::Acquire));
    assert!(session.process_exited.load(Ordering::Acquire));
    assert!(session.master.lock().unwrap().is_none());
    assert_eq!(child.kills.load(Ordering::SeqCst), 0);
}

pub(super) fn session_without_cleanup_receipt() -> Arc<super::super::TerminalSession> {
    use super::super::{TerminalSession, TerminalState};
    use std::{collections::VecDeque, sync::Mutex};
    Arc::new(TerminalSession {
        master: Mutex::new(None),
        input_tx: Mutex::new(None),
        child: Mutex::new(ChildOwner::new(Box::new(FakeChild(state(false))))),
        state: Mutex::new(TerminalState {
            cwd: String::new(),
            rows: 24,
            cols: 80,
            transcript: VecDeque::new(),
            transcript_bytes: 0,
            sequence: 0,
            truncated: false,
        }),
        #[cfg(unix)]
        process_id: None,
        closed: AtomicBool::new(false),
        process_exited: AtomicBool::new(false),
        exit_notified: AtomicBool::new(false),
        #[cfg(windows)]
        console_closed: AtomicBool::new(false),
        #[cfg(windows)]
        output_drained: AtomicBool::new(false),
    })
}

#[test]
fn unknown_cleanup_stops_client_waiting_after_output_but_keeps_owner_and_never_duplicates_exit() {
    use super::super::{TerminalRegistry, notification, notify_exit, record_output};
    use kcoder_app_protocol::method;
    let session = session_without_cleanup_receipt();
    let registry = TerminalRegistry::default();
    let peer = session_without_cleanup_receipt();
    registry
        .0
        .lock()
        .unwrap()
        .insert("peer".into(), peer.clone());
    registry
        .0
        .lock()
        .unwrap()
        .insert("fixture".into(), session.clone());
    let (send, mut receive) = tokio::sync::mpsc::channel(8);
    let sequence = record_output(&session, "tail你");
    send.blocking_send(notification(
        method::TERMINAL_OUTPUT,
        serde_json::json!({"session_id":"fixture","sequence":sequence,"data":"tail你"}),
    ))
    .unwrap();
    notify_exit(&registry, "fixture", &session, &send, Some(0));
    assert_eq!(registry.resource_count(), Some(2));
    let output = receive.try_recv().unwrap();
    let exit = receive.try_recv().unwrap();
    assert_eq!(output["method"], method::TERMINAL_OUTPUT);
    assert_eq!(exit["method"], method::TERMINAL_EXIT);
    assert!(exit["params"]["sequence"].as_u64().unwrap() > sequence);
    assert!(exit["params"]["exit_code"].is_null());
    session.process_exited.store(true, Ordering::Release);
    #[cfg(windows)]
    {
        session.console_closed.store(true, Ordering::Release);
        session.output_drained.store(true, Ordering::Release);
    }
    notify_exit(&registry, "fixture", &session, &send, Some(0));
    assert_eq!(registry.resource_count(), Some(1));
    assert!(!peer.closed.load(Ordering::Acquire));
    assert!(registry.0.lock().unwrap().contains_key("peer"));
    assert!(receive.try_recv().is_err());
}

#[cfg(windows)]
#[test]
fn child_exit_alone_never_releases_an_unconfirmed_console() {
    let session = session_without_cleanup_receipt();
    session.process_exited.store(true, Ordering::Release);
    session.output_drained.store(true, Ordering::Release);
    assert!(!super::super::cleanup_complete(&session));
}
