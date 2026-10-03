//! Release only recorded worker input after its Job Object is empty. The caller
//! must keep the input observer alive throughout this operation. Never hold the
//! ledger mutex while calling SendInput: its hook callback may need that mutex.
use crate::{
    desktop::inspect_interactive_desktop,
    input_ownership::{InputControl, InputOwnership, InputRelease},
    windows_process::{CleanupJob, JobChild},
};
use anyhow::{Result, anyhow, ensure};
use std::{sync::Mutex, time::Duration};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

pub fn terminate_and_release(
    child: &mut JobChild,
    ownership: &Mutex<InputOwnership>,
    session_id: u32,
    input_tag: usize,
    timeout: Duration,
) -> Result<()> {
    terminate_and_release_with(
        || child.terminate_and_wait(timeout),
        ownership,
        session_id,
        input_tag,
    )
}

/// Independent cleanup uses the same ownership ledger and post-exit rules as
/// the live host. It does not need the vanished host's stdio or process object.
pub fn terminate_guardian_job_and_release(
    job: &mut CleanupJob,
    ownership: &Mutex<InputOwnership>,
    session_id: u32,
    input_tag: usize,
    timeout: Duration,
) -> Result<()> {
    terminate_and_release_with(
        || job.terminate_and_wait(timeout),
        ownership,
        session_id,
        input_tag,
    )
}

fn terminate_and_release_with(
    terminate: impl FnOnce() -> Result<()>,
    ownership: &Mutex<InputOwnership>,
    session_id: u32,
    input_tag: usize,
) -> Result<()> {
    ensure!(
        input_tag != 0 && session_id != 0,
        "invalid desktop cleanup identity"
    );
    ownership
        .lock()
        .map_err(|_| anyhow!("input ownership lock poisoned"))?
        .begin_stop();
    terminate()?;
    let releases = ownership
        .lock()
        .map_err(|_| anyhow!("input ownership lock poisoned"))?
        .releases_after_worker_exit();
    for release in releases {
        // External input may have changed since the initial cleanup snapshot.
        if !ownership
            .lock()
            .map_err(|_| anyhow!("input ownership lock poisoned"))?
            .releases_after_worker_exit()
            .contains(&release)
        {
            continue;
        }
        let desktop = inspect_interactive_desktop()
            .map_err(|error| anyhow!("input cleanup desktop unavailable: {error:?}"))?;
        ensure!(
            desktop.session_id == session_id,
            "input cleanup session changed"
        );
        let input = release_input(release, input_tag)?;
        let accepted = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) };
        ensure!(
            accepted == 1,
            "Windows did not confirm input release; ownership retained"
        );
        ownership
            .lock()
            .map_err(|_| anyhow!("input ownership lock poisoned"))?
            .confirm_release(release);
    }
    Ok(())
}

fn release_input(release: InputRelease, input_tag: usize) -> Result<INPUT> {
    let mut input = INPUT::default();
    match release.control {
        InputControl::Key(key) => {
            ensure!((1..=254).contains(&key), "invalid owned virtual key");
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki = KEYBDINPUT {
                wVk: if release.unicode { 0 } else { u16::from(key) },
                wScan: release.scan_code,
                dwFlags: KEYEVENTF_KEYUP
                    | if release.extended && !release.unicode {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        0
                    }
                    | if release.unicode {
                        KEYEVENTF_UNICODE
                    } else {
                        0
                    },
                time: 0,
                dwExtraInfo: input_tag,
            };
        }
        control => {
            let (flags, data) = match control {
                InputControl::LeftMouse => (MOUSEEVENTF_LEFTUP, 0),
                InputControl::RightMouse => (MOUSEEVENTF_RIGHTUP, 0),
                InputControl::MiddleMouse => (MOUSEEVENTF_MIDDLEUP, 0),
                InputControl::X1Mouse => (MOUSEEVENTF_XUP, 1),
                InputControl::X2Mouse => (MOUSEEVENTF_XUP, 2),
                InputControl::Key(_) => unreachable!(),
            };
            input.r#type = INPUT_MOUSE;
            input.Anonymous.mi = MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: input_tag,
            };
        }
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyboard_cleanup_preserves_scan_and_tag_but_only_injects_key_up() {
        let value = InputRelease {
            control: InputControl::Key(17),
            scan_code: 29,
            extended: true,
            unicode: false,
        };
        let input = release_input(value, 123).unwrap();
        assert_eq!(input.r#type, INPUT_KEYBOARD);
        let key = unsafe { input.Anonymous.ki };
        assert_eq!(key.wVk, 17);
        assert_eq!(key.wScan, 29);
        assert_eq!(key.dwFlags, KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY);
        assert_eq!(key.dwExtraInfo, 123);
        let unicode = release_input(
            InputRelease {
                unicode: true,
                ..value
            },
            123,
        )
        .unwrap();
        let key = unsafe { unicode.Anonymous.ki };
        assert_eq!(key.wVk, 0);
        assert_eq!(key.dwFlags, KEYEVENTF_KEYUP | KEYEVENTF_UNICODE);
    }
    #[test]
    fn mouse_cleanup_never_moves_pointer_and_invalid_keys_are_rejected() {
        let value = InputRelease {
            control: InputControl::X2Mouse,
            scan_code: 0,
            extended: false,
            unicode: false,
        };
        let input = release_input(value, 456).unwrap();
        assert_eq!(input.r#type, INPUT_MOUSE);
        let mouse = unsafe { input.Anonymous.mi };
        assert_eq!((mouse.dx, mouse.dy), (0, 0));
        assert_eq!(mouse.dwFlags, MOUSEEVENTF_XUP);
        assert_eq!(mouse.mouseData, 2);
        assert_eq!(mouse.dwExtraInfo, 456);
        assert!(
            release_input(
                InputRelease {
                    control: InputControl::Key(0),
                    ..value
                },
                456
            )
            .is_err()
        );
    }
}
