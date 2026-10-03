"""Real Win32 clipboard tests in an owned, noninteractive window station.
No access to the user's clipboard or input desktop is needed.
"""
import ctypes
import importlib.util
import json
from pathlib import Path
import site
import sys
import uuid

root = Path(sys.argv[1])
site.addsitedir(str(root / 'packages'))
spec = importlib.util.spec_from_file_location('owned_clipboard', Path(__file__).with_name('clipboard_paste.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
pointer = ctypes.c_void_p
user32.GetProcessWindowStation.restype = pointer
user32.GetThreadDesktop.argtypes = [ctypes.c_ulong]
user32.GetThreadDesktop.restype = pointer
user32.CreateWindowStationW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong, pointer]
user32.CreateWindowStationW.restype = pointer
user32.SetProcessWindowStation.argtypes = [pointer]
user32.CreateDesktopW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, pointer, ctypes.c_ulong, ctypes.c_ulong, pointer]
user32.CreateDesktopW.restype = pointer
user32.SetThreadDesktop.argtypes = [pointer]
user32.CloseDesktop.argtypes = [pointer]
user32.CloseWindowStation.argtypes = [pointer]
original_station = user32.GetProcessWindowStation()
original_desktop = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
station = desktop = None
report = {'status':'failed','userClipboardAccessed':False,'cases':[]}
def require(value, operation):
    if not value: raise OSError(ctypes.get_last_error(), operation)
    return value
try:
    station = require(user32.CreateWindowStationW('KCoderClipboardTest-'+uuid.uuid4().hex, 0, 0x37f, None), 'create owned window station')
    require(user32.SetProcessWindowStation(station), 'select owned window station')
    desktop = require(user32.CreateDesktopW('Default', None, None, 0, 0x1ff, None), 'create owned desktop')
    require(user32.SetThreadDesktop(desktop), 'select owned desktop')
    import win32con
    import win32gui
    import win32clipboard
    rich = win32clipboard.RegisterClipboardFormat('Rich Text Format')
    with module.WindowsClipboard() as clipboard:
        edit = win32gui.CreateWindowEx(0, 'EDIT', '', win32con.WS_CHILD | win32con.ES_MULTILINE,
                                      0, 0, 300, 100, clipboard.window, 0, 0, None)
        try:
            def contents():
                clipboard.open()
                try: return dict(module.snapshot(clipboard))
                finally: clipboard.close()
            def seed(values):
                clipboard.open()
                try: module.restore_locked(clipboard, list(values.items()))
                finally: clipboard.close()
            text = 'KCoder '+('\u4e2d\u6587 English \U0001f600 '*4)
            for prior in [{}, {13:'prior fixture text', rich:b'{\\rtf1\\ansi prior rich text}'}]:
                seed(prior)
                before = contents()
                win32gui.SetWindowText(edit, '')
                def paste(keys):
                    assert keys == '{Ctrl}v', 'unexpected clipboard fallback'
                    win32gui.SendMessage(edit, win32con.WM_PASTE, 0, 0)
                module.paste_text(text, paste, clipboard=clipboard)
                assert win32gui.GetWindowText(edit) == text, 'native edit received different text'
                assert contents() == before, 'clipboard formats changed after paste'
                report['cases'].append('empty_paste' if not prior else 'rich_paste')
            seed({13:'before exception',rich:b'{\\rtf1 fixture}'})
            before = contents()
            def fail(_): raise RuntimeError('owned injected send failure')
            try: module.paste_text('new text', fail, clipboard=clipboard)
            except RuntimeError as error: assert str(error) == 'owned injected send failure'
            else: raise AssertionError('input exception was hidden')
            assert contents() == before, 'ordinary exception lost clipboard formats'
            report['cases'].append('exception_restored')
            def replace(_): seed({13:'external fixture copy'})
            module.paste_text('new text', replace, clipboard=clipboard)
            assert contents().get(13) == 'external fixture copy', 'external copy was overwritten'
            report['cases'].append('external_copy_preserved')
            def replace_retaining_marker(_):
                clipboard.open()
                try: clipboard.set(13, 'external update retaining marker')
                finally: clipboard.close()
            module.paste_text('new text', replace_retaining_marker, clipboard=clipboard)
            assert contents().get(13) == 'external update retaining marker', 'external update was overwritten'
            report['cases'].append('external_update_preserved')
            report['status'] = 'passed'
        finally:
            win32gui.DestroyWindow(edit)
except Exception as error:
    report['error'] = type(error).__name__ + ': ' + str(error)[:300]
finally:
    if station:
        restored_station = bool(user32.SetProcessWindowStation(original_station))
        restored_desktop = bool(user32.SetThreadDesktop(original_desktop))
        closed_desktop = not desktop or bool(user32.CloseDesktop(desktop))
        closed_station = bool(user32.CloseWindowStation(station))
        report['cleanup'] = all([restored_station, restored_desktop, closed_desktop, closed_station])
        if not report['cleanup']: report['status'] = 'failed'
print(json.dumps(report))
sys.exit(0 if report['status'] == 'passed' else 1)
