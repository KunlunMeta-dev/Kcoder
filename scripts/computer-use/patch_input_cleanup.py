"""Patch the pinned worker's ordinary-exception modifier cleanup.
This does not claim that Python finally blocks survive process termination.
"""
from pathlib import Path

HELPER = '''from contextlib import contextmanager


@contextmanager
def _kcoder_held_key(key):
    owned = not uia.IsKeyPressed(key)
    try:
        if owned:
            uia.PressKey(key, waitTime=0.05)
        yield
    finally:
        if owned:
            uia.ReleaseKey(key, waitTime=0.05)


'''


def patch(source):
    if '_kcoder_held_key' in source:
        raise ValueError('Input cleanup patch is already present')
    replacements = []
    for wheel in ('WheelUp', 'WheelDown'):
        old = (f'                        uia.PressKey(uia.Keys.VK_SHIFT, waitTime=0.05)\n'
               f'                        uia.{wheel}(wheel_times)\n'
               f'                        sleep(0.05)\n'
               f'                        uia.ReleaseKey(uia.Keys.VK_SHIFT, waitTime=0.05)')
        new = (f'                        with _kcoder_held_key(uia.Keys.VK_SHIFT):\n'
               f'                            uia.{wheel}(wheel_times)\n'
               f'                            sleep(0.05)')
        if source.count(old) != 1:
            raise ValueError('Pinned scroll implementation changed; update input cleanup patch')
        replacements.append((old, new))
    anchor = 'logger = logging.getLogger(__name__)'
    if source.count(anchor) != 1:
        raise ValueError('Pinned service import layout changed')
    for old, new in replacements:
        source = source.replace(old, new)
    return source.replace(anchor, HELPER + anchor)


if __name__ == '__main__':
    import ast
    import sys
    target = Path(sys.argv[1])
    result = patch(target.read_text(encoding='utf-8'))
    ast.parse(result)
    target.write_text(result, encoding='utf-8')
