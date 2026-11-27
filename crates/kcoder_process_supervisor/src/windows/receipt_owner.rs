//! Receipt mode retains the original supervisor outside the target's private Job.
use super::*;
use crate::protocol::CleanupSpawnRequest;
use crate::windows_cleanup_receipt::Writer;
use windows_sys::Win32::System::Threading::TerminateProcess;

pub fn run<R: BufRead + Send + 'static>(request: CleanupSpawnRequest, input: R) -> Result<u32> {
    request.validate()?;
    let mut receipt = Writer::from_transferred(request.receipt_handle, &request.receipt_identity)?;
    let mut status = StatusWriter::create(&request.spawn.status_file)?;
    let job = Job::create()?;
    let stdout = inherited_standard_handle(STD_OUTPUT_HANDLE)?;
    let stderr = inherited_standard_handle(STD_ERROR_HANDLE)?;
    let stdin = null_input_handle()?;
    // The completion file and private Job handle never enter this target list.
    let mut attributes = AttributeList::new(&[stdin.0, stdout, stderr])?;
    let process =
        create_suspended_process(&request.spawn, stdin.0, stdout, stderr, &mut attributes)?;
    drop(attributes);
    drop(stdin);
    let result = job
        .assign_target(process.process.0)
        .and_then(|()| supervise(&request.spawn, input, &job, &mut status, &process));
    if result.is_err() {
        // Assignment may have failed. The original paused process handle is still
        // authoritative, so terminate and join it even when it never entered Job.
        let _ = job.terminate(1);
        let state = unsafe { WaitForSingleObject(process.process.0, 0) };
        if state != WAIT_OBJECT_0_VALUE {
            anyhow::ensure!(
                unsafe { TerminateProcess(process.process.0, 1) } != 0,
                "failed to terminate original receipt target"
            );
        }
    }
    // An impatient or dead host does not shorten the cleanup owner's duty. Only
    // the real target terminal handle plus an empty original Job permits writing.
    wait_for_process(process.process.0)?;
    while job.active_processes()? != 0 {
        std::thread::sleep(Duration::from_millis(10));
    }
    receipt.confirm()?;
    if let Err(error) = result {
        write_supervisor_error(&mut status, &error)?;
        return Err(error);
    }
    let mut code = 1;
    anyhow::ensure!(
        unsafe { GetExitCodeProcess(process.process.0, &mut code) } != 0,
        "cannot observe original receipt target exit code"
    );
    status.write(&SupervisorEvent::Exit { code })?;
    Ok(code)
}

fn supervise<R: BufRead + Send + 'static>(
    request: &SpawnRequest,
    input: R,
    job: &Job,
    status: &mut StatusWriter,
    process: &OwnedProcessInformation,
) -> Result<()> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || read_controls(input, sender));
    status.write(&SupervisorEvent::Ready {
        version: PROTOCOL_VERSION,
        nonce: &request.nonce,
        pid: process.process_id,
    })?;
    let first = receiver
        .recv_timeout(START_TIMEOUT)
        .context("receipt START command missing")?;
    let ControlMessage::Command(Ok(start)) = first else {
        anyhow::bail!("invalid receipt START command")
    };
    start.validate(&request.nonce)?;
    anyhow::ensure!(
        matches!(start, ControlRequest::Start { .. }),
        "receipt START command required"
    );
    anyhow::ensure!(
        unsafe { ResumeThread(process.thread.0) } == 1,
        "receipt target was not suspended exactly once"
    );
    let mut stopping = false;
    loop {
        if !stopping {
            match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(ControlMessage::Command(Ok(command))) => {
                    if command.validate(&request.nonce).is_err()
                        || !matches!(command, ControlRequest::Kill { .. })
                    {
                        anyhow::bail!("invalid receipt control command")
                    }
                    job.terminate(1)?;
                    stopping = true;
                }
                Ok(_) | Err(RecvTimeoutError::Disconnected) => {
                    job.terminate(1)?;
                    stopping = true;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
        match unsafe { WaitForSingleObject(process.process.0, 0) } {
            WAIT_OBJECT_0_VALUE if job.active_processes()? == 0 => return Ok(()),
            WAIT_OBJECT_0_VALUE | WAIT_TIMEOUT_VALUE => {}
            _ => anyhow::bail!("cannot observe original receipt target"),
        }
    }
}
