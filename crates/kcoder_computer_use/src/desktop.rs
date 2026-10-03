//! Read-only interactive desktop preflight. Never switches or unlocks desktops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveDesktop {
    pub session_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopPreflightError {
    UnsupportedPlatform,
    SystemError(u32),
    NonInteractiveSession,
    DesktopUnavailable,
}

/// Watch independently of MCP calls so a blocked exchange cannot hide desktop
/// loss. Returning is terminal for this lease; callers must stop its worker.
pub async fn wait_until_unavailable(session_id: u32) {
    monitor_desktop(
        session_id,
        std::time::Duration::from_millis(250),
        inspect_interactive_desktop,
    )
    .await;
}

async fn monitor_desktop(
    session_id: u32,
    period: std::time::Duration,
    mut inspect: impl FnMut() -> Result<InteractiveDesktop, DesktopPreflightError>,
) {
    let mut ticks = tokio::time::interval(period);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        if !matches!(inspect(), Ok(desktop) if desktop.session_id == session_id) {
            return;
        }
    }
}

#[cfg(test)]
mod monitor_tests {
    use super::*;

    #[tokio::test]
    async fn desktop_loss_is_terminal_even_if_a_later_check_would_recover() {
        let mut calls = 0;
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            monitor_desktop(3, std::time::Duration::from_millis(1), || {
                calls += 1;
                if calls == 2 {
                    Err(DesktopPreflightError::DesktopUnavailable)
                } else {
                    Ok(InteractiveDesktop { session_id: 3 })
                }
            }),
        )
        .await
        .unwrap();
        assert_eq!(calls, 2);
    }

    #[tokio::test]
    async fn different_session_or_inspection_error_revokes_lease() {
        for result in [
            Ok(InteractiveDesktop { session_id: 4 }),
            Err(DesktopPreflightError::SystemError(5)),
        ] {
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                monitor_desktop(3, std::time::Duration::from_millis(1), || result.clone()),
            )
            .await
            .unwrap();
        }
    }
}

/// Call immediately before acquiring control and again before each input action.
/// This proves desktop availability only, not permission or IPC peer identity.
#[cfg(not(windows))]
pub fn inspect_interactive_desktop() -> Result<InteractiveDesktop, DesktopPreflightError> {
    Err(DesktopPreflightError::UnsupportedPlatform)
}

#[cfg(windows)]
pub fn inspect_interactive_desktop() -> Result<InteractiveDesktop, DesktopPreflightError> {
    use windows_sys::Win32::{
        Foundation::GetLastError,
        System::{
            RemoteDesktop::{
                ProcessIdToSessionId, WTS_CURRENT_SERVER_HANDLE, WTSFreeMemory, WTSINFOEXW,
                WTSQuerySessionInformationW, WTSSessionInfoEx,
            },
            StationsAndDesktops::{
                CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop,
                UOI_NAME,
            },
            Threading::GetCurrentProcessId,
        },
    };
    let mut session_id = 0;
    // All pointers below refer to initialized, correctly sized local storage.
    unsafe {
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) == 0 {
            return Err(DesktopPreflightError::SystemError(GetLastError()));
        }
        if session_id == 0 {
            return Err(DesktopPreflightError::NonInteractiveSession);
        }
        let mut state_buffer = std::ptr::null_mut();
        let mut state_size = 0;
        if WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session_id,
            WTSSessionInfoEx,
            &mut state_buffer,
            &mut state_size,
        ) == 0
        {
            return Err(DesktopPreflightError::SystemError(GetLastError()));
        }
        // WTSActive and an input desktop named Default do not prove unlocked:
        // Windows 11 can display LockApp on that desktop. Query the explicit
        // session lock flag as well. Unknown/truncated replies fail closed.
        let active = if !state_buffer.is_null()
            && state_size as usize >= std::mem::size_of::<WTSINFOEXW>()
        {
            unlocked_session_metadata(
                std::slice::from_raw_parts(state_buffer.cast::<u8>(), state_size as usize),
                session_id,
            )
        } else {
            false
        };
        WTSFreeMemory(state_buffer.cast());
        if !active {
            return Err(DesktopPreflightError::DesktopUnavailable);
        }
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return Err(DesktopPreflightError::DesktopUnavailable);
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            std::mem::size_of_val(&name) as u32,
            &mut needed,
        );
        let error = if ok == 0 { Some(GetLastError()) } else { None };
        CloseDesktop(desktop);
        if let Some(error) = error {
            return Err(DesktopPreflightError::SystemError(error));
        }
        if needed == 0 || needed as usize > std::mem::size_of_val(&name) {
            return Err(DesktopPreflightError::DesktopUnavailable);
        }
        let end = name
            .iter()
            .position(|value| *value == 0)
            .ok_or(DesktopPreflightError::DesktopUnavailable)?;
        let name = String::from_utf16(&name[..end])
            .map_err(|_| DesktopPreflightError::DesktopUnavailable)?;
        if !name.eq_ignore_ascii_case("default") {
            return Err(DesktopPreflightError::DesktopUnavailable);
        }
        Ok(InteractiveDesktop { session_id })
    }
}

#[cfg(windows)]
fn unlocked_session_metadata(bytes: &[u8], session_id: u32) -> bool {
    use windows_sys::Win32::System::RemoteDesktop::{
        WTS_SESSIONSTATE_UNLOCK, WTSActive, WTSINFOEXW,
    };
    if bytes.len() < std::mem::size_of::<WTSINFOEXW>() {
        return false;
    }
    // The size is checked above; WTSINFOEXW contains only scalar fields/arrays.
    let info = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<WTSINFOEXW>()) };
    if info.Level != 1 {
        return false;
    }
    let state = unsafe { info.Data.WTSInfoExLevel1 };
    state.SessionId == session_id
        && state.SessionState == WTSActive
        && state.SessionFlags == WTS_SESSIONSTATE_UNLOCK as i32
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::unlocked_session_metadata;
    use windows_sys::Win32::System::RemoteDesktop::WTSINFOEXW;

    #[test]
    fn active_session_is_not_sufficient_without_explicit_unlock() {
        let mut bytes = vec![0u8; std::mem::size_of::<WTSINFOEXW>()];
        // Write through the SDK's layout, including its union alignment.
        let mut info = WTSINFOEXW::default();
        info.Level = 1;
        info.Data.WTSInfoExLevel1.SessionId = 3;
        for (flags, expected) in [(0, false), (-1, false), (2, false), (1, true)] {
            info.Data.WTSInfoExLevel1.SessionFlags = flags;
            unsafe {
                std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<WTSINFOEXW>(), info);
            }
            assert_eq!(unlocked_session_metadata(&bytes, 3), expected);
        }
        assert!(!unlocked_session_metadata(&bytes, 4));
        assert!(!unlocked_session_metadata(&bytes[..bytes.len() - 1], 3));
        info.Level = 2;
        unsafe {
            std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<WTSINFOEXW>(), info);
        }
        assert!(!unlocked_session_metadata(&bytes, 3));
        info.Level = 1;
        info.Data.WTSInfoExLevel1.SessionState = 4; // WTSDisconnected
        unsafe {
            std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<WTSINFOEXW>(), info);
        }
        assert!(!unlocked_session_metadata(&bytes, 3));
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn non_windows_is_explicitly_unavailable() {
        assert_eq!(
            super::inspect_interactive_desktop(),
            Err(super::DesktopPreflightError::UnsupportedPlatform)
        );
    }
}
