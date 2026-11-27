//! A child forked from the test process and parked between fork and exec,
//! while it still carries every descriptor inherited from the parent. This
//! reproduces another thread spawning a subprocess during a lock hold.

use std::io::{PipeWriter, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::Child;
use std::thread::JoinHandle;

pub(crate) struct ChildBeforeExec {
    gate: PipeWriter,
    spawner: JoinHandle<Child>,
}

impl ChildBeforeExec {
    /// Returns once the child has forked and is blocked before exec.
    pub(crate) fn fork() -> Self {
        let (gate_reader, gate) = std::io::pipe().unwrap();
        let (mut ready_reader, ready_writer) = std::io::pipe().unwrap();
        let (gate_fd, ready_fd) = (gate_reader.as_raw_fd(), ready_writer.as_raw_fd());
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", ":"]);
        // SAFETY: the hook only calls async-signal-safe write/read on pipe
        // descriptors that stay open until the spawner thread finishes.
        unsafe {
            command.pre_exec(move || {
                let mut byte = 0_u8;
                libc::write(ready_fd, (&raw const byte).cast(), 1);
                libc::read(gate_fd, (&raw mut byte).cast(), 1);
                Ok(())
            });
        }
        // `spawn` returns only after exec, so it runs on its own thread.
        let spawner = std::thread::spawn(move || {
            let child = command.spawn().unwrap();
            drop((gate_reader, ready_writer));
            child
        });
        let mut ready = [0_u8];
        ready_reader.read_exact(&mut ready).unwrap();
        Self { gate, spawner }
    }

    /// Lets the child exec (closing its close-on-exec duplicates) and reaps it.
    pub(crate) fn exec_and_wait(mut self) {
        self.gate.write_all(&[1]).unwrap();
        assert!(self.spawner.join().unwrap().wait().unwrap().success());
    }
}
