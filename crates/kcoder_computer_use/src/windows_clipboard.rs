//! Thread-affine clipboard transaction for the independent recovery process.
//! Original formats stay in memory; no clipboard payload is logged or returned.
use anyhow::{Result, ensure};
use std::{
    marker::PhantomData,
    ptr::{null, null_mut},
    rc::Rc,
};
use windows_sys::Win32::{
    Foundation::{GetLastError, GlobalFree, HWND, SetLastError},
    Globalization::{CP_ACP, CP_OEMCP, GetSystemDefaultLCID, WideCharToMultiByte},
    System::{DataExchange::*, Memory::*},
    UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE},
};
use zeroize::Zeroizing;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_FORMATS: usize = 128;
const UNICODE_TEXT: u32 = 13;
const LOCALE: u32 = 16;
type Formats = Vec<(u32, Zeroizing<Vec<u8>>)>;

struct Transaction {
    prior: Formats,
    marker: Vec<u8>,
    sequence: u32,
}
pub struct ClipboardTransaction {
    window: HWND,
    marker_format: u32,
    active: Option<Transaction>,
    restoration_failed: bool,
    _thread: PhantomData<Rc<()>>,
}
struct OpenClipboardGuard;
impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

impl ClipboardTransaction {
    pub fn new() -> Result<Self> {
        let marker_format =
            unsafe { RegisterClipboardFormatW(windows_sys::w!("KCoder.DesktopPaste.Owner.v1")) };
        ensure!(marker_format != 0, "clipboard marker registration failed");
        let window = unsafe {
            CreateWindowExW(
                0,
                windows_sys::w!("STATIC"),
                windows_sys::w!("KCoder recovery clipboard"),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                null_mut(),
                null_mut(),
                null(),
            )
        };
        ensure!(!window.is_null(), "clipboard owner window creation failed");
        Ok(Self {
            window,
            marker_format,
            active: None,
            restoration_failed: false,
            _thread: PhantomData,
        })
    }
    fn open(&self) -> Result<OpenClipboardGuard> {
        ensure!(
            unsafe { OpenClipboard(self.window) } != 0,
            "clipboard is unavailable"
        );
        Ok(OpenClipboardGuard)
    }
    /// False selects keyboard fallback without changing an unsupported or busy
    /// clipboard. Only a successful snapshot permits temporary publication.
    pub fn begin(&mut self, text: &str) -> Result<bool> {
        self.begin_if_current(text, || true)
    }
    pub(crate) fn begin_if_current(
        &mut self,
        text: &str,
        is_current: impl Fn() -> bool,
    ) -> Result<bool> {
        ensure!(
            !self.restoration_failed,
            "previous clipboard restoration was not confirmed"
        );
        ensure!(is_current(), "clipboard publication cancelled");
        ensure!(
            self.active.is_none(),
            "clipboard transaction already active"
        );
        ensure!(
            !text.contains('\0') && text.len() <= 128 * 1024,
            "unsupported clipboard input size or NUL"
        );
        let _open = match self.open() {
            Ok(open) => open,
            Err(_) => return Ok(false),
        };
        let prior = match snapshot() {
            Ok(prior) => prior,
            Err(_) => return Ok(false),
        };
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let unicode = Zeroizing::new(
            wide.iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        let ansi = narrow_text(&wide, CP_ACP)?;
        let oem = narrow_text(&wide, CP_OEMCP)?;
        let marker = uuid::Uuid::new_v4().as_bytes().to_vec();
        // Snapshotting a delayed-rendering format can take time. Cancellation
        // during that read must not publish later after the owner has stopped.
        ensure!(is_current(), "clipboard publication cancelled");
        let publication = (|| {
            ensure!(
                unsafe { EmptyClipboard() } != 0,
                "clipboard publication failed"
            );
            set_bytes(self.marker_format, &marker)?;
            set_bytes(UNICODE_TEXT, &unicode)?;
            // Prevent CloseClipboard from synthesizing formats and advancing
            // the sequence after the clipboard lock has been released.
            set_bytes(1, &ansi)?;
            set_bytes(7, &oem)?;
            set_bytes(LOCALE, &unsafe { GetSystemDefaultLCID() }.to_le_bytes())?;
            Ok::<_, anyhow::Error>(())
        })();
        if let Err(error) = publication {
            if let Err(restore_error) = restore(&prior) {
                self.restoration_failed = true;
                return Err(restore_error);
            }
            return Err(error);
        }
        self.active = Some(Transaction {
            prior,
            marker,
            sequence: unsafe { GetClipboardSequenceNumber() },
        });
        Ok(true)
    }
    /// Restore only this exact publication. An intervening external copy or
    /// update, including one retaining the marker, is never overwritten.
    pub fn finish(&mut self) -> Result<()> {
        ensure!(
            !self.restoration_failed,
            "previous clipboard restoration was not confirmed"
        );
        let Some(active) = self.active.as_ref() else {
            return Ok(());
        };
        let _open = self.open()?;
        if unsafe { GetClipboardSequenceNumber() } == active.sequence
            && unsafe { GetClipboardOwner() } == self.window
        {
            let marker = get_bytes(self.marker_format, MAX_BYTES)?;
            if marker.starts_with(&active.marker)
                && marker[active.marker.len()..].iter().all(|byte| *byte == 0)
            {
                if let Err(error) = restore(&active.prior) {
                    self.restoration_failed = true;
                    return Err(error);
                }
            }
        }
        self.active.take();
        Ok(())
    }
}
impl Drop for ClipboardTransaction {
    fn drop(&mut self) {
        let _ = self.finish(); // Explicit finish is required for a success receipt.
        unsafe {
            DestroyWindow(self.window);
        }
    }
}

fn copyable(format: u32) -> bool {
    if matches!(format, 1 | 4 | 5 | 6 | 7 | 8 | 11 | 12 | 13 | 15 | 16 | 17) {
        return true;
    }
    if format < 0xc000 {
        return false;
    }
    // A registered HGLOBAL is not necessarily self-contained: OLE/private
    // formats can contain references invalidated by EmptyClipboard. Unknown
    // formats select untouched keyboard fallback rather than copying pointers.
    let mut name = [0u16; 256];
    let length = unsafe { GetClipboardFormatNameW(format, name.as_mut_ptr(), name.len() as i32) };
    if length <= 0 {
        return false;
    }
    let name = String::from_utf16_lossy(&name[..length as usize]);
    [
        "Rich Text Format",
        "HTML Format",
        "PNG",
        "JFIF",
        "image/png",
        "text/html",
        "text/plain",
        "KCoder.DesktopPaste.Owner.v1",
    ]
    .iter()
    .any(|known| name.eq_ignore_ascii_case(known))
}
fn snapshot() -> Result<Formats> {
    let mut result = Vec::new();
    let mut format = 0;
    let mut remaining = MAX_BYTES;
    loop {
        unsafe {
            SetLastError(0);
        }
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            ensure!(
                unsafe { GetLastError() } == 0,
                "clipboard format enumeration failed"
            );
            return Ok(result);
        }
        ensure!(
            copyable(format) && result.len() < MAX_FORMATS,
            "clipboard format requires keyboard fallback"
        );
        let bytes = get_bytes(format, remaining)?;
        remaining -= bytes.len();
        result.push((format, bytes));
    }
}
fn get_bytes(format: u32, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    let handle = unsafe { GetClipboardData(format) };
    ensure!(!handle.is_null(), "clipboard format unavailable");
    let size = unsafe { GlobalSize(handle) };
    ensure!(
        size > 0 && size <= limit,
        "clipboard format cannot be copied within budget"
    );
    let pointer = unsafe { GlobalLock(handle) };
    ensure!(!pointer.is_null(), "clipboard format lock failed");
    let copy =
        Zeroizing::new(unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), size) }.to_vec());
    unsafe {
        GlobalUnlock(handle);
    }
    Ok(copy)
}
fn set_bytes(format: u32, bytes: &[u8]) -> Result<()> {
    ensure!(!bytes.is_empty(), "empty clipboard allocation");
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) };
    ensure!(!memory.is_null(), "clipboard allocation failed");
    let pointer = unsafe { GlobalLock(memory) };
    if pointer.is_null() {
        unsafe {
            GlobalFree(memory);
        }
        anyhow::bail!("clipboard allocation lock failed");
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
        GlobalUnlock(memory);
    }
    if unsafe { SetClipboardData(format, memory) }.is_null() {
        unsafe {
            GlobalFree(memory);
        }
        anyhow::bail!("clipboard format publication failed");
    }
    Ok(()) // Ownership transferred to Windows, never free this handle here.
}
fn restore(formats: &Formats) -> Result<()> {
    ensure!(
        unsafe { EmptyClipboard() } != 0,
        "clipboard restoration failed"
    );
    for (format, bytes) in formats {
        set_bytes(*format, bytes)?;
    }
    Ok(())
}
fn narrow_text(wide: &[u16], codepage: u32) -> Result<Zeroizing<Vec<u8>>> {
    let size = unsafe {
        WideCharToMultiByte(
            codepage,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            null_mut(),
            0,
            null(),
            null_mut(),
        )
    };
    ensure!(size > 0, "clipboard text conversion failed");
    let mut bytes = Zeroizing::new(vec![0; size as usize]);
    ensure!(
        unsafe {
            WideCharToMultiByte(
                codepage,
                0,
                wide.as_ptr(),
                wide.len() as i32,
                bytes.as_mut_ptr(),
                size,
                null(),
                null_mut(),
            )
        } == size,
        "clipboard text conversion failed"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::{StationsAndDesktops::*, Threading::GetCurrentThreadId};
    struct PrivateDesktop {
        station: HWINSTA,
        desktop: HDESK,
        old_station: HWINSTA,
        old_desktop: HDESK,
    }
    impl PrivateDesktop {
        fn new() -> Self {
            let old_station = unsafe { GetProcessWindowStation() };
            let old_desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
            let name: Vec<u16> = format!("KCoderClipboardTest-{}", uuid::Uuid::new_v4())
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let station = unsafe { CreateWindowStationW(name.as_ptr(), 0, 0x37f, null()) };
            assert!(!station.is_null());
            let mut value = Self {
                station,
                desktop: null_mut(),
                old_station,
                old_desktop,
            };
            assert_ne!(unsafe { SetProcessWindowStation(station) }, 0);
            value.desktop = unsafe {
                CreateDesktopW(windows_sys::w!("Default"), null(), null(), 0, 0x1ff, null())
            };
            assert!(!value.desktop.is_null());
            assert_ne!(unsafe { SetThreadDesktop(value.desktop) }, 0);
            value
        }
    }
    impl Drop for PrivateDesktop {
        fn drop(&mut self) {
            let station = unsafe { SetProcessWindowStation(self.old_station) };
            let desktop = unsafe { SetThreadDesktop(self.old_desktop) };
            let closed_desktop =
                self.desktop.is_null() || unsafe { CloseDesktop(self.desktop) } != 0;
            let closed_station = unsafe { CloseWindowStation(self.station) } != 0;
            if !std::thread::panicking() {
                assert!(station != 0 && desktop != 0 && closed_desktop && closed_station);
            }
        }
    }
    fn contents(clipboard: &ClipboardTransaction) -> Formats {
        let _open = clipboard.open().unwrap();
        snapshot().unwrap()
    }
    #[test]
    #[ignore = "requires an owned private Windows window station; run alone"]
    fn private_station_clipboard_restore_and_external_update_protection() {
        let _desktop = PrivateDesktop::new();
        let mut clipboard = ClipboardTransaction::new().unwrap();
        assert!(contents(&clipboard).is_empty());
        assert!(
            clipboard
                .begin("中文 English 😀 long clipboard fixture text")
                .unwrap()
        );
        clipboard.finish().unwrap();
        assert!(contents(&clipboard).is_empty());
        let rich = unsafe { RegisterClipboardFormatW(windows_sys::w!("Rich Text Format")) };
        {
            let _open = clipboard.open().unwrap();
            set_bytes(
                UNICODE_TEXT,
                &"original 文本\0"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            set_bytes(rich, b"{\\rtf1 fixture rich text}\0").unwrap();
        }
        let before = contents(&clipboard);
        assert!(clipboard.begin("replacement fixture input").unwrap());
        clipboard.finish().unwrap();
        assert_eq!(contents(&clipboard), before);
        assert!(clipboard.begin("second replacement").unwrap());
        // An external modification may retain our marker. Sequence protection
        // must still prevent replacing that new clipboard value.
        {
            let _open = clipboard.open().unwrap();
            set_bytes(rich, b"external update retaining marker\0").unwrap();
        }
        let external = contents(&clipboard);
        clipboard.finish().unwrap();
        assert_eq!(contents(&clipboard), external);
        let unknown = unsafe {
            RegisterClipboardFormatW(windows_sys::w!("KCoder fixture opaque external format"))
        };
        {
            let _open = clipboard.open().unwrap();
            set_bytes(unknown, b"opaque fixture data\0").unwrap();
        }
        let sequence = unsafe { GetClipboardSequenceNumber() };
        assert!(!clipboard.begin("must use keyboard fallback").unwrap());
        assert_eq!(unsafe { GetClipboardSequenceNumber() }, sequence);
        let _open = clipboard.open().unwrap();
        assert!(
            get_bytes(unknown, MAX_BYTES)
                .unwrap()
                .starts_with(b"opaque fixture data\0")
        );
    }

    #[test]
    #[ignore = "requires an owned private Windows window station; run alone"]
    fn private_station_clipboard_actor_shutdown_restores() {
        let _desktop = PrivateDesktop::new();
        let inspector = ClipboardTransaction::new().unwrap();
        let original = contents(&inspector);
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let actor = crate::windows_clipboard_actor::ClipboardActor::start()
                    .await
                    .unwrap();
                assert!(
                    actor
                        .begin("owned fixture 中文 😀 temporary text".into())
                        .await
                        .unwrap()
                );
                assert!(!contents(&inspector).is_empty());
                actor.finish().await.unwrap();
                assert_eq!(contents(&inspector), original);
                assert!(
                    actor
                        .begin("second owned fixture temporary text".into())
                        .await
                        .unwrap()
                );
                actor.shutdown().await.unwrap();
                assert_eq!(contents(&inspector), original);
            });
    }
}
