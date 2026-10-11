//! Short-lived input observation for an authorized desktop worker. Keeps only
//! held controls, never text/history. Tagged worker events are distinguished
//! from physical input and other applications' injections.
use crate::input_ownership::{InputControl, InputOwnership, InputRelease};
use anyhow::{Result, anyhow};
use std::{
    cell::RefCell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::*},
};

struct Shared {
    tag: usize,
    ledger: Arc<Mutex<InputOwnership>>,
    exit: AtomicBool,
    failed: AtomicBool,
    started: Instant,
    heartbeat: AtomicU64,
}
thread_local! { static CURRENT: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) }; }

pub struct InputObserver {
    shared: Arc<Shared>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl InputObserver {
    pub fn start() -> Result<Arc<Self>> {
        let mut random = [0u8; 4];
        getrandom::fill(&mut random).map_err(|_| anyhow!("input marker generation failed"))?;
        Self::start_with_authorized_tag(
            ((u32::from_ne_bytes(random) & 0x7fff_ffff).max(1)) as usize,
        )
    }

    /// Recovery handoff uses the exact tag established before worker launch.
    /// This is a native-host API, never a tool/model-configurable input marker.
    pub(crate) fn start_with_authorized_tag(tag: usize) -> Result<Arc<Self>> {
        anyhow::ensure!(
            (1..=0x7fff_ffff).contains(&tag),
            "invalid authorized input marker"
        );
        crate::desktop::inspect_interactive_desktop()
            .map_err(|e| anyhow!("input observer desktop unavailable: {e:?}"))?;
        let shared = Arc::new(Shared {
            tag,
            ledger: Arc::new(Mutex::new(InputOwnership::default())),
            exit: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            started: Instant::now(),
            heartbeat: AtomicU64::new(0),
        });
        let state = shared.clone();
        let (ready, received) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || run(state, ready));
        let observer = Arc::new(Self {
            shared,
            thread: Mutex::new(Some(thread)),
        });
        received
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| anyhow!("input observer startup timed out"))?
            .map_err(|code| anyhow!("input observer registration failed ({code})"))?;
        Ok(observer)
    }
    pub fn tag(&self) -> usize {
        self.shared.tag
    }
    pub fn ownership(&self) -> &Mutex<InputOwnership> {
        &self.shared.ledger
    }
    pub fn healthy(&self) -> bool {
        !self.shared.exit.load(Ordering::Acquire)
            && !self.shared.failed.load(Ordering::Acquire)
            && crate::input_health::heartbeat_is_fresh(
                self.shared.started.elapsed().as_millis() as u64,
                self.shared.heartbeat.load(Ordering::Acquire),
            )
    }
    pub fn shutdown(&self) {
        self.shared.exit.store(true, Ordering::Release);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}
impl Drop for InputObserver {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run(state: Arc<Shared>, ready: mpsc::SyncSender<Result<(), u32>>) {
    CURRENT.with(|slot| *slot.borrow_mut() = Some(state.clone()));
    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    let keyboard = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) };
    if keyboard.is_null() {
        let _ = ready.send(Err(unsafe { GetLastError() }));
        return;
    }
    let mouse = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0) };
    if mouse.is_null() {
        let error = unsafe { GetLastError() };
        unsafe {
            UnhookWindowsHookEx(keyboard);
        }
        let _ = ready.send(Err(error));
        return;
    }
    if let Ok(mut ledger) = state.ledger.lock() {
        for key in 8u8..=254 {
            // Hooks normalize generic modifiers to left/right controls.
            if ![16, 17, 18].contains(&key) && unsafe { GetAsyncKeyState(i32::from(key)) } < 0 {
                ledger.external_transition(InputControl::Key(key), true);
            }
        }
        for (key, control) in [
            (1, InputControl::LeftMouse),
            (2, InputControl::RightMouse),
            (4, InputControl::MiddleMouse),
            (5, InputControl::X1Mouse),
            (6, InputControl::X2Mouse),
        ] {
            if unsafe { GetAsyncKeyState(key) } < 0 {
                ledger.external_transition(control, true);
            }
        }
    } else {
        state.failed.store(true, Ordering::Release);
    }
    let _ = ready.send(Ok(()));
    let mut message: MSG = unsafe { std::mem::zeroed() };
    while !state.exit.load(Ordering::Acquire) {
        mark_alive(&state);
        while !state.exit.load(Ordering::Acquire)
            && unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0
        {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            mark_alive(&state);
        }
        state.heartbeat.store(
            state.started.elapsed().as_millis() as u64,
            Ordering::Release,
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    unsafe {
        UnhookWindowsHookEx(mouse);
        UnhookWindowsHookEx(keyboard);
    }
    CURRENT.with(|slot| *slot.borrow_mut() = None);
}

fn mark_alive(state: &Shared) {
    state.heartbeat.store(
        state.started.elapsed().as_millis() as u64,
        Ordering::Release,
    );
}

fn observe(
    extra: usize,
    injected: bool,
    control: Option<(InputControl, bool, InputRelease)>,
) -> bool {
    CURRENT.with(|slot| {
        let Some(state) = slot.borrow().clone() else {
            return true;
        };
        mark_alive(&state);
        let owned = injected && extra == state.tag;
        let Ok(mut ledger) = state.ledger.lock() else {
            state.failed.store(true, Ordering::Release);
            return !owned;
        };
        match control {
            Some((control, down, release)) if owned => {
                if down {
                    ledger.owned_down(release)
                } else {
                    ledger.owned_up(control)
                }
            }
            Some((control, down, _)) => {
                ledger.external_transition(control, down);
                true
            }
            None => !owned || ledger.allow_owned_motion_or_wheel(),
        }
    })
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 && lparam != 0 {
        let event = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        if let Ok(mut key) = u8::try_from(event.vkCode) {
            let extended = event.flags & LLKHF_EXTENDED != 0;
            key = match key {
                16 => {
                    if event.scanCode == 54 {
                        161
                    } else {
                        160
                    }
                }
                17 => {
                    if extended {
                        163
                    } else {
                        162
                    }
                }
                18 => {
                    if extended {
                        165
                    } else {
                        164
                    }
                }
                _ => key,
            };
            let control = InputControl::Key(key);
            let release = InputRelease {
                control,
                scan_code: event.scanCode as u16,
                extended,
                unicode: key == 231,
            };
            if !observe(
                event.dwExtraInfo,
                event.flags & LLKHF_INJECTED != 0,
                Some((control, event.flags & LLKHF_UP == 0, release)),
            ) {
                return 1;
            }
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}
unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 && lparam != 0 {
        let event = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
        let control = match wparam as u32 {
            WM_LBUTTONDOWN => Some((InputControl::LeftMouse, true)),
            WM_LBUTTONUP => Some((InputControl::LeftMouse, false)),
            WM_RBUTTONDOWN => Some((InputControl::RightMouse, true)),
            WM_RBUTTONUP => Some((InputControl::RightMouse, false)),
            WM_MBUTTONDOWN => Some((InputControl::MiddleMouse, true)),
            WM_MBUTTONUP => Some((InputControl::MiddleMouse, false)),
            WM_XBUTTONDOWN | WM_XBUTTONUP => match event.mouseData >> 16 {
                1 => Some((InputControl::X1Mouse, wparam as u32 == WM_XBUTTONDOWN)),
                2 => Some((InputControl::X2Mouse, wparam as u32 == WM_XBUTTONDOWN)),
                _ => None,
            },
            _ => None,
        }
        .map(|(control, down)| {
            (
                control,
                down,
                InputRelease {
                    control,
                    scan_code: 0,
                    extended: false,
                    unicode: false,
                },
            )
        });
        if !observe(event.dwExtraInfo, event.flags & 1 != 0, control) {
            return 1;
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}
