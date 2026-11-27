//! Private launcher handshake and shutdown proof for an explicitly owned manager.
use std::{
    io::{self, Write},
    os::fd::{AsRawFd, RawFd},
    process::Child,
    time::{Duration, Instant},
};

const START: &[u8] = b"native_code_service_manager_start_v1\n";

pub(super) fn write_ready(output: &mut impl Write) -> io::Result<()> {
    output.write_all(
        b"{\"event\":\"native_code_service_manager_owner_ready\",\"contractVersion\":1,\"ownerMode\":\"private_stdin_v1\"}\n",
    )?;
    output.flush()
}

/// No worker may be restored or accepted until this original private pipe releases it.
pub(super) fn await_start(
    input: &impl AsRawFd,
    stopped: impl Fn() -> bool,
    timeout: Duration,
) -> io::Result<bool> {
    let fd = input.as_raw_fd();
    verify_pipe(fd)?;
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::with_capacity(START.len());
    loop {
        if stopped() || Instant::now() >= deadline {
            return Ok(false);
        }
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: descriptor references the still-held launcher pipe.
        let count = unsafe { libc::poll(&mut descriptor, 1, 50) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            continue;
        }
        let mut byte = 0u8;
        // SAFETY: the caller holds fd and byte points to one writable byte.
        let count = unsafe { libc::read(fd, (&mut byte as *mut u8).cast(), 1) };
        if count == 0 {
            return Ok(false);
        }
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        bytes.push(byte);
        if !START.starts_with(&bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "NATIVE_CODE_MANAGER_OWNER_HANDSHAKE_INVALID",
            ));
        }
        if bytes == START {
            return Ok(true);
        }
    }
}

fn verify_pipe(fd: RawFd) -> io::Result<()> {
    // SAFETY: fstat initializes this plain C structure on success.
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut metadata) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if metadata.st_mode & libc::S_IFMT == libc::S_IFSOCK {
        // Node's stdio: 'pipe' uses an inherited Unix stream socket pair.
        // Reject network sockets and datagram descriptors at the same boundary.
        let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
        let mut kind = 0i32;
        let mut kind_length = std::mem::size_of_val(&kind) as libc::socklen_t;
        if unsafe {
            libc::getsockname(
                fd,
                (&mut address as *mut libc::sockaddr_storage).cast(),
                &mut length,
            )
        } == 0
            && address.ss_family as i32 == libc::AF_UNIX
            && unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut kind as *mut i32).cast(),
                    &mut kind_length,
                )
            } == 0
            && kind == libc::SOCK_STREAM
        {
            return Ok(());
        }
    }
    if metadata.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NATIVE_CODE_MANAGER_OWNER_PIPE_REQUIRED",
        ));
    }
    Ok(())
}

/// Only actual unreaped Child handles from this manager participate in cleanup.
pub(super) fn stop_children<'a>(children: impl Iterator<Item = &'a mut Child>) -> io::Result<()> {
    let mut children = children.collect::<Vec<_>>();
    let mut failures = Vec::new();
    let mut unobservable = vec![false; children.len()];
    for (index, child) in children.iter_mut().enumerate() {
        let running = match child.try_wait() {
            Ok(status) => status.is_none(),
            Err(error) => {
                // An unknown wait status cannot justify signaling a reused PID.
                unobservable[index] = true;
                failures.push(("observe", error));
                continue;
            }
        };
        if running && child.stdin.take().is_none() {
            // SAFETY: an unreaped Child retains this PID until wait observes exit.
            if unsafe { libc::kill(child.id() as i32, libc::SIGTERM) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    failures.push(("signal", error));
                }
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    for (index, child) in children.into_iter().enumerate() {
        if unobservable[index] {
            continue;
        }
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(error) => {
                    failures.push(("observe", error));
                    break;
                }
            }
            if Instant::now() >= deadline {
                match child.kill() {
                    Ok(()) => {
                        if let Err(error) = child.wait() {
                            failures.push(("wait", error));
                        }
                    }
                    Err(error) => failures.push(("force", error)),
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(io::Error::other(ChildDrainErrors(failures)))
    }
}

#[derive(Debug)]
struct ChildDrainErrors(Vec<(&'static str, io::Error)>);
impl std::fmt::Display for ChildDrainErrors {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "NATIVE_CODE_MANAGER_CHILD_DRAIN_UNCONFIRMED")?;
        for (stage, error) in &self.0 {
            write!(formatter, "; {stage}: {error}")?;
        }
        Ok(())
    }
}
impl std::error::Error for ChildDrainErrors {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0
            .first()
            .map(|(_, error)| error as &dyn std::error::Error)
    }
}

pub(super) fn write_stopped(output: &mut impl Write, released: bool) -> io::Result<()> {
    writeln!(
        output,
        "{{\"event\":\"native_code_service_manager_stopped\",\"contractVersion\":1,\"ownerMode\":\"private_stdin_v1\",\"startupReleased\":{released},\"ownedWorkersExited\":true}}"
    )?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, os::fd::FromRawFd};

    fn pipe() -> (File, File) {
        let mut descriptors = [-1; 2];
        assert_eq!(
            unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) },
            0
        );
        // SAFETY: pipe2 transfers two newly owned descriptors to these Files.
        unsafe {
            (
                File::from_raw_fd(descriptors[0]),
                File::from_raw_fd(descriptors[1]),
            )
        }
    }

    #[test]
    fn only_one_complete_private_pipe_handshake_releases_startup() {
        let (input, mut output) = pipe();
        output.write_all(START).unwrap();
        assert!(await_start(&input, || false, Duration::from_secs(1)).unwrap());
        for bytes in [b"".as_slice(), &START[..START.len() - 1]] {
            let (input, mut output) = pipe();
            output.write_all(bytes).unwrap();
            drop(output);
            assert!(!await_start(&input, || false, Duration::from_secs(1)).unwrap());
        }
    }

    #[test]
    fn stop_deadline_and_invalid_input_never_release_startup() {
        let (input, _output) = pipe();
        assert!(!await_start(&input, || true, Duration::from_secs(1)).unwrap());
        assert!(!await_start(&input, || false, Duration::ZERO).unwrap());
        let (input, mut output) = pipe();
        output.write_all(b"wrong\n").unwrap();
        assert!(await_start(&input, || false, Duration::from_secs(1)).is_err());
        assert!(await_start(&File::open("/dev/null").unwrap(), || false, Duration::ZERO).is_err());
        let (input, mut output) = std::os::unix::net::UnixStream::pair().unwrap();
        output.write_all(START).unwrap();
        assert!(await_start(&input, || false, Duration::from_secs(1)).unwrap());
    }

    #[test]
    fn complete_child_drain_waits_every_original_child() {
        let mut children = (0..2)
            .map(|_| {
                std::process::Command::new("/usr/bin/sleep")
                    .arg("30")
                    .spawn()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let result = stop_children(children.iter_mut());
        // Retain exact Child handles even if an assertion fails.
        for child in &mut children {
            let _ = child.kill();
            let _ = child.wait();
        }
        result.unwrap();
        assert!(
            children
                .iter_mut()
                .all(|child| child.try_wait().unwrap().is_some())
        );
    }

    #[test]
    fn a_lost_child_status_does_not_skip_other_original_children() {
        let mut lost = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let mut later = std::process::Command::new("/usr/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        // Simulate another owner of waitpid consuming this exact child's status.
        // The production drain must retain ECHILD without signaling that PID.
        assert_eq!(
            unsafe { libc::waitpid(lost.id() as i32, std::ptr::null_mut(), 0) },
            lost.id() as i32
        );
        let result = stop_children([&mut lost, &mut later].into_iter());
        let later_was_waited = later.try_wait().unwrap().is_some();
        if !later_was_waited {
            let _ = later.kill();
            let _ = later.wait();
        }
        assert!(
            result.is_err(),
            "Lost original status cannot become a successful complete drain"
        );
        assert!(
            later_was_waited,
            "A failed earlier child cannot skip later owned cleanup"
        );
    }
}
