//! Offline process probe of the actual manager startup gate and complete Child drain.
#![cfg(target_os = "linux")]
#[path = "../../../../src/app_server/integrations/core/service_leases/user_manager_startup.rs"]
mod startup;

use std::{
    io,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: i32) {
    STOP.store(true, Ordering::Release);
}

fn main() -> io::Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.get(1).map(String::as_str) == Some("--probe-worker") {
        // SAFETY: the handler performs only a lock-free atomic store.
        unsafe { libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t) };
        std::fs::write(format!("{}/worker-started", arguments[2]), "1")?;
        while !STOP.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::write(format!("{}/worker-stopped", arguments[2]), "1")?;
        return Ok(());
    }
    assert_eq!(arguments.len(), 4);
    assert_eq!(
        arguments[1],
        "--internal-native-code-service-manager-owned-v1"
    );
    let mode = std::env::var("KCODER_NATIVE_STARTUP_PROBE_MODE").unwrap_or_default();
    // SAFETY: this synchronous entry has not created threads.
    unsafe { libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t) };
    if mode != "ready-lost" && mode != "ready-lost-forged-released" && mode != "legacy-no-receipt" {
        startup::write_ready(&mut io::stdout().lock())?;
    }
    let released = startup::await_start(
        &io::stdin(),
        || STOP.load(Ordering::Acquire),
        Duration::from_secs(10),
    )?;
    let mut children = Vec::new();
    if released {
        if mode == "lost-child-status" {
            let lost = Command::new("/usr/bin/true").spawn()?;
            // Consume this exact owned status outside Child to inject ECHILD.
            assert_eq!(
                unsafe { libc::waitpid(lost.id() as i32, std::ptr::null_mut(), 0) },
                lost.id() as i32
            );
            children.push(lost);
        }
        children.push(
            Command::new(std::env::current_exe()?)
                .arg("--probe-worker")
                .arg(&arguments[3])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        while !STOP.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    startup::stop_children(children.iter_mut())?;
    if mode != "legacy-no-receipt" {
        startup::write_stopped(
            &mut io::stdout().lock(),
            released || mode == "ready-lost-forged-released",
        )?;
    }
    Ok(())
}
