import unittest
from types import SimpleNamespace
from patch_unicode_input import PREFIX


class UnicodeInputTests(unittest.TestCase):
    def test_non_bmp_has_tagged_sender_surrogate_down_and_up_pairs(self):
        inputs = []
        namespace = {'KeyboardInput':lambda *parts:parts,
                     'KeyboardEventFlag':SimpleNamespace(KeyUnicode=4,KeyDown=0,KeyUp=2),
                     'SendInput':lambda *events:inputs.extend(events)}
        exec('def send(char):\n'+PREFIX+'    return "bmp"\n',namespace)
        namespace['send']('\U0001f600')
        self.assertEqual(inputs, [(0,0xD83D,4),(0,0xD83D,6),(0,0xDE00,4),(0,0xDE00,6)])
        self.assertEqual(namespace['send']('中'),'bmp')
        with self.assertRaises(ValueError):namespace['send']('ab')


if __name__ == '__main__':unittest.main()
