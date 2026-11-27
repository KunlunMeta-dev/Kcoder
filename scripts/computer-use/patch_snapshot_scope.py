"""Apply requested screen scope before UIA, and do not retry failed windows."""
from pathlib import Path


def patch(source):
    changes = [
        ('            controls_handles = self.get_controls_handles()  # Taskbar,Program Manager,Apps, Dialogs\n',
         '''            controls_handles = self.get_controls_handles()  # Taskbar,Program Manager,Apps, Dialogs
            if capture_rect is not None:
                scoped_handles = set()
                for handle in controls_handles:
                    try:
                        left, top, right, bottom = win32gui.GetWindowRect(handle)
                        if (right > capture_rect.left and left < capture_rect.right
                                and bottom > capture_rect.top and top < capture_rect.bottom):
                            scoped_handles.add(handle)
                    except Exception:
                        pass  # Window disappeared during enumeration.
                controls_handles = scoped_handles
'''),
        ('            controls_handles = controls_handles or self.get_controls_handles()\n            for depth, hwnd in enumerate(controls_handles):',
         '            if controls_handles is None:\n                controls_handles = self.get_controls_handles()\n            for depth, hwnd in enumerate(list(controls_handles)):'),
        ('                    child = uia.ControlFromHandle(hwnd)\n                except Exception:\n                    continue',
         '''                    child = uia.ControlFromHandle(hwnd)
                    if child is None:
                        controls_handles.discard(hwnd)
                        continue
                except Exception:
                    # Do not put a timed-out provider back into the subsequent
                    # "other windows" traversal and repeat the same failure.
                    controls_handles.discard(hwnd)
                    continue'''),
    ]
    for old, new in changes:
        if source.count(old) != 1:
            raise ValueError("Pinned snapshot enumeration changed")
        source = source.replace(old, new)
    return source


if __name__ == "__main__":
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding="utf-8"))
    ast.parse(result)
    path.write_text(result, encoding="utf-8")
