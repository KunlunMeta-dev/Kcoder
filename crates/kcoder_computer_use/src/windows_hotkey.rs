//! Dedicated OS message queue for Ctrl+Alt+Shift+F9. The callback must be
//! nonblocking (enqueue the stop operation); it does not share the MCP lock.
use anyhow::{Result, anyhow};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use windows_sys::Win32::{
    Foundation::GetLastError,
    UI::{
        Input::KeyboardAndMouse::{
            MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey, UnregisterHotKey, VK_F9,
        },
        WindowsAndMessaging::{MSG, PM_REMOVE, PeekMessageW, WM_HOTKEY},
    },
};

pub const EMERGENCY_STOP_SHORTCUT: &str = "Ctrl+Alt+Shift+F9";
const ID: i32 = 0x4b43;
pub struct EmergencyStopHotkey {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl EmergencyStopHotkey {
    pub fn register(callback: impl FnOnce() + Send + 'static) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let registered = unsafe {
                RegisterHotKey(
                    std::ptr::null_mut(),
                    ID,
                    MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                    VK_F9 as u32,
                )
            };
            if registered == 0 {
                let _ = tx.send(Err(unsafe { GetLastError() }));
                return;
            }
            if tx.send(Ok(())).is_err() {
                unsafe {
                    UnregisterHotKey(std::ptr::null_mut(), ID);
                }
                return;
            }
            let mut callback = Some(callback);
            let mut message: MSG = unsafe { std::mem::zeroed() };
            while !stopping.load(Ordering::Acquire) {
                while unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) }
                    != 0
                {
                    if message.message == WM_HOTKEY && message.wParam == ID as usize {
                        if let Some(callback) = callback.take() {
                            callback();
                        }
                        stopping.store(true, Ordering::Release);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            unsafe {
                UnregisterHotKey(std::ptr::null_mut(), ID);
            }
        });
        let guard = Self {
            stop,
            thread: Some(thread),
        };
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(guard),
            Ok(Err(code)) => Err(anyhow!(
                "{EMERGENCY_STOP_SHORTCUT} registration failed ({code}); desktop control was not enabled"
            )),
            Err(_) => Err(anyhow!("emergency stop registration did not complete")),
        }
    }
}
impl Drop for EmergencyStopHotkey {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
