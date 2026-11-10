"""Deterministic proxy precedence checks; no network or user registry is accessed."""
import os
import sys
import unittest
from unittest.mock import patch
import urllib.request

import launch


class SystemProxyTest(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_windows_native_proxy_is_inherited_with_loopback_bypass(self):
        proxy = "http://127.0.0.1:12345"
        with patch.object(sys, "platform", "win32"), patch.object(urllib.request, "getproxies_registry", return_value={"http": proxy, "https": proxy, "ftp": "ignored"}, create=True):
            launch.configure_system_proxy()
        self.assertEqual(os.environ["HTTP_PROXY"], proxy)
        self.assertEqual(os.environ["HTTPS_PROXY"], proxy)
        self.assertEqual(os.environ["NO_PROXY"], "localhost,127.0.0.1,::1")
        self.assertNotIn("FTP_PROXY", os.environ)

    def test_explicit_proxy_variables_including_empty_values_disable_native_fallback(self):
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            for value in ("", "http://explicit.invalid"):
                with self.subTest(name=name, empty=not value), patch.dict(os.environ, {name: value}, clear=True), patch.object(sys, "platform", "win32"), patch.object(urllib.request, "getproxies_registry", create=True) as lookup:
                    launch.configure_system_proxy()
                    lookup.assert_not_called()
                    self.assertEqual(os.environ[name], value)
                    self.assertEqual(len(os.environ), 1)

    @patch.dict(os.environ, {"NO_PROXY": "internal.example"}, clear=True)
    def test_an_explicit_bypass_list_is_preserved(self):
        with patch.object(sys, "platform", "win32"), patch.object(urllib.request, "getproxies_registry", return_value={"https": "http://127.0.0.1:12345"}, create=True):
            launch.configure_system_proxy()
        self.assertEqual(os.environ["NO_PROXY"], "internal.example")

    @patch.dict(os.environ, {}, clear=True)
    def test_other_platforms_and_windows_without_a_proxy_keep_the_environment(self):
        with patch.object(sys, "platform", "linux"), patch.object(urllib.request, "getproxies_registry", create=True) as lookup:
            launch.configure_system_proxy()
            lookup.assert_not_called()
        with patch.object(sys, "platform", "win32"), patch.object(urllib.request, "getproxies_registry", return_value={}, create=True):
            launch.configure_system_proxy()
        self.assertEqual(dict(os.environ), {})


if __name__ == "__main__":
    unittest.main()
