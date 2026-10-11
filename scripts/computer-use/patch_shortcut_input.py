"""Use actual extended scan codes instead of marking every shortcut key E0."""
from pathlib import Path


def patch(source):
    start = source.index('def _VKtoSC(key: int) -> int:\n')
    end = source.index('\ndef SendKeys(', start)
    if 'MapVirtualKeyA(key, 0)' not in source[start:end]:
        raise ValueError('Pinned scan-code mapper changed')
    source = source[:start] + '''def _VKtoSC(key: int) -> int:
    # MAPVK_VK_TO_VSC_EX preserves E0/E1 prefixes and respects the actual layout.
    return ctypes.windll.user32.MapVirtualKeyW(key, 4)

''' + source[end:]
    old = '            keybd_event(key[0], scanCode, key[1], 0)'
    new = '''            flags = key[1] & ~KeyboardEventFlag.ExtendedKey
            if (scanCode & 0xFF00) == 0xE000:
                flags |= KeyboardEventFlag.ExtendedKey
            keybd_event(key[0], scanCode & 0xFF, flags, 0)'''
    if source.count(old) != 1:
        raise ValueError('Pinned shortcut sender changed')
    return source.replace(old, new)


if __name__ == '__main__':
    import ast
    import sys
    path = Path(sys.argv[1])
    result = patch(path.read_text(encoding='utf-8'))
    ast.parse(result)
    path.write_text(result, encoding='utf-8')
