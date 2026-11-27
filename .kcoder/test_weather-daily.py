#!/usr/bin/env python3
"""weather-daily 的单元测试。运行：python3 .kcoder/test_weather-daily.py"""

import contextlib
import datetime
import importlib.util
import io
import json
import os
import shlex
import shutil
import tempfile
import unittest
import urllib.error
from unittest import mock

MODULE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weather-daily.py")
spec = importlib.util.spec_from_file_location("weather_daily", MODULE_PATH)
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

# 隔离用户自己的默认配置文件：否则本套件的断言会随本地状态漂移。
wd.DEFAULT_CONFIG_FILE = os.path.join(
    os.path.dirname(MODULE_PATH), ".test-nonexistent-default-config.json")


def daily_payload(dates=("2026-10-23", "2026-10-24", "2026-10-25")):
    return json.dumps({
        "daily": {
            "time": list(dates),
            "weather_code": [3, 61, 55],
            "temperature_2m_max": [15.9, 17.1, 14.1],
            "temperature_2m_min": [7.1, 8.5, 10.0],
            "precipitation_probability_max": [8, 80, 79],
            "wind_speed_10m_max": [10.5, 8.2, 8.3],
            "wind_direction_10m_dominant": [185, 13, 4],
        }
    }).encode()


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class WindDirTests(unittest.TestCase):
    def test_cardinal_and_intercardinal(self):
        cases = {0: "北", 360: "北", 45: "东北", 90: "东", 135: "东南",
                 180: "南", 225: "西南", 270: "西", 315: "西北"}
        for deg, expected in cases.items():
            self.assertEqual(wd.wind_dir(deg), expected, f"deg={deg}")


class WindForceTests(unittest.TestCase):
    def test_boundaries(self):
        cases = {0.5: "无风", 5.9: "软风", 11.9: "轻风", 19.9: "微风",
                 28.9: "和风", 38.9: "强风", 60: "大风"}
        for kmh, expected in cases.items():
            self.assertEqual(wd.wind_force(kmh), expected, f"kmh={kmh}")


class AdviceTests(unittest.TestCase):
    def test_cold(self):
        self.assertIn("保暖", wd.advice(2.0, 9.0))

    def test_large_diurnal_range(self):
        self.assertIn("薄外套", wd.advice(12.0, 25.0))

    def test_mild(self):
        self.assertIn("舒适", wd.advice(18.0, 24.0))


class BuildTests(unittest.TestCase):
    def build(self, payload):
        with mock.patch.object(wd, "fetch", return_value=payload):
            return wd.build("http://unused")

    def test_selects_tomorrow_not_today(self):
        """核心回归：daily[0] 是今天，播报对象必须是 daily[1]。"""
        body = self.build(daily_payload())
        self.assertIn("2026-10-24", body)   # 明天
        self.assertNotIn("2026-10-23", body)  # 今天不得出现
        self.assertNotIn("2026-10-25", body)  # 后天不得出现

    def test_uses_tomorrows_values_not_todays(self):
        body = self.build(daily_payload())
        # 明天的最高温 17.1，今天是 15.9 —— 不能串
        self.assertIn("8.5~17.1°C", body)
        self.assertIn("小雨", body)      # 明天的 code=61
        self.assertIn("降水概率：80%", body)  # 明天的 80，不是今天的 8

    def test_umbrella_hint_only_when_pop_high(self):
        self.assertIn("记得带伞", self.build(daily_payload()))

        payload = json.loads(daily_payload())
        payload["daily"]["precipitation_probability_max"] = [8, 10, 79]
        body = self.build(json.dumps(payload).encode())
        self.assertIn("无需带伞", body)
        self.assertNotIn("记得带伞", body)

    def test_wind_uses_tomorrow(self):
        body = self.build(daily_payload())
        # 明天 8.2km/h -> <12 落在「轻风」档；风向 13deg -> 北
        self.assertIn("北轻风（8.2km/h）", body)

    def test_weekday_rendered(self):
        # date -d 2026-10-24 +%A = Saturday
        self.assertIn("星期六", self.build(daily_payload()))

    def test_missing_tomorrow_raises(self):
        payload = json.loads(daily_payload(dates=("2026-10-23",)))
        with self.assertRaises(RuntimeError):
            self.build(json.dumps(payload).encode())

    def test_single_day_payload_raises(self):
        payload = json.loads(daily_payload(dates=("2026-10-23",)))
        payload["daily"]["time"] = ["2026-10-23"]
        with self.assertRaises(Exception):
            self.build(json.dumps(payload).encode())

    def test_unknown_wmo_code_does_not_crash(self):
        payload = json.loads(daily_payload())
        payload["daily"]["weather_code"] = [0, 999, 0]
        self.assertIn("代码999", self.build(json.dumps(payload).encode()))


class PushTests(unittest.TestCase):
    def test_headers_are_latin1_safe(self):
        """回归：HTTP 头必须 latin-1 可编码。

        曾经把中文标题放进 Title 头，真实执行时 http.client 抛
        UnicodeEncodeError；而 mock 掉 urlopen 的旧测试完全测不到。
        这里不 mock，直接检查 Request 的实际编码行为。
        """
        req = wd.build_request("播报正文")
        for name, value in req.header_items():
            with self.subTest(header=name):
                value.encode("latin-1")  # 不抛即通过

    def test_request_encodes_end_to_end(self):
        """真实走一遍 http.client 的头编码路径，绕不过去才是真过。"""
        import http.client
        req = wd.build_request("播报正文")
        fake = mock.Mock()
        fake.get_method.return_value = req.get_method()
        fake.selector = lambda: req.selector
        fake.request = http.client.HTTPConnection.request.__get__(fake)
        http.client.HTTPConnection.request(fake, req.get_method(), req.selector,
                                           req.data, req.headers)

    def test_payload_carries_topic_title_and_message(self):
        req = wd.build_request("你好\n第二行")
        payload = json.loads(req.data.decode("utf-8"))
        self.assertEqual(payload["topic"], wd.CONFIG["NTFY_TOPIC"])
        self.assertEqual(payload["title"], wd.CONFIG["NTFY_TITLE"])
        self.assertEqual(payload["message"], "你好\n第二行")

    def test_title_is_not_a_header(self):
        """中文标题必须在 body 里，不能出现在 header 里。"""
        req = wd.build_request("正文")
        self.assertNotIn("Title", {k for k, _ in req.header_items()})

    def test_push_returns_status(self):
        def fake_urlopen(req, timeout=None):
            return FakeResponse(b'{"ok":true}', status=200)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            self.assertEqual(wd.push("你好\n第二行"), 200)


class DedupeTests(unittest.TestCase):
    """当日去重：KCoder automation 与系统 crontab 两个触发源不应重复推送。"""

    def setUp(self):
        self.state = os.path.join(os.path.dirname(MODULE_PATH), ".test-push-state")
        self.patch = mock.patch.object(wd, "STATE_FILE", self.state)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        if os.path.exists(self.state):
            os.remove(self.state)

    def tearDown(self):
        if os.path.exists(self.state):
            os.remove(self.state)

    def run_main(self, force=False):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = wd.main(force=force)
        return code, buf.getvalue()

    def test_missing_state_means_not_pushed(self):
        self.assertFalse(wd.already_pushed_today())

    def test_corrupt_state_means_not_pushed(self):
        """状态文件坏了要当没推过：宁可多推一次，不要漏推。"""
        with open(self.state, "w", encoding="utf-8") as fh:
            fh.write("乱码不是日期")
        self.assertFalse(wd.already_pushed_today())

    def test_stale_date_is_not_today(self):
        with open(self.state, "w", encoding="utf-8") as fh:
            fh.write("1999-01-01")
        self.assertFalse(wd.already_pushed_today())

    def test_first_run_pushes_and_second_skips(self):
        with mock.patch.object(wd, "build", return_value="正文"), \
             mock.patch.object(wd, "push", return_value=200):
            code1, out1 = self.run_main()
            self.assertEqual(code1, 0)
            self.assertIn("已推送到手机", out1)

            code2, out2 = self.run_main()
            self.assertEqual(code2, 0)
            self.assertIn("今日已推送过", out2)
        self.assertTrue(wd.already_pushed_today())

    def test_force_bypasses_dedupe(self):
        with mock.patch.object(wd, "build", return_value="正文"), \
             mock.patch.object(wd, "push", return_value=200):
            self.run_main()
            code, out = self.run_main(force=True)
        self.assertEqual(code, 0)
        self.assertIn("已推送到手机", out)

    def test_failed_push_is_not_marked(self):
        """推送失败不能标记成功，否则当天补推会被去重挡掉。"""
        with mock.patch.object(wd, "build", return_value="正文"), \
             mock.patch.object(wd, "push", side_effect=urllib.error.URLError("down")):
            code, _ = self.run_main()
        self.assertEqual(code, 3)
        self.assertFalse(wd.already_pushed_today())


class MainTests(unittest.TestCase):
    def setUp(self):
        """隔离真实的推送状态文件。

        否则本套件第一次跑绿、第二次跑红：首次运行会写入
        .weather-last-push，后续运行命中去重分支。
        """
        self.state = os.path.join(os.path.dirname(MODULE_PATH), ".test-main-state")
        self.patch = mock.patch.object(wd, "STATE_FILE", self.state)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        if os.path.exists(self.state):
            os.remove(self.state)

    def tearDown(self):
        if os.path.exists(self.state):
            os.remove(self.state)

    def run_main(self):
        """捕获 main() 的 stdout，避免污染测试输出。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = wd.main()
        return code, buf.getvalue()

    def test_fetch_failure_is_loud_and_skips_push(self):
        with mock.patch.object(wd, "build", side_effect=RuntimeError("boom")), \
             mock.patch.object(wd, "push", side_effect=AssertionError("不应推送")):
            code, out = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("天气获取失败", out)

    def test_push_failure_still_prints_body(self):
        with mock.patch.object(wd, "build", return_value="播报正文"), \
             mock.patch.object(wd, "push", side_effect=urllib.error.URLError("no route")):
            code, out = self.run_main()
        self.assertEqual(code, 3)
        self.assertIn("播报正文", out)
        self.assertIn("手机推送失败", out)

    def test_success_writes_file(self):
        with mock.patch.object(wd, "build", return_value="播报正文"), \
             mock.patch.object(wd, "push", return_value=200):
            code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("已推送到手机", out)
        with open("/tmp/kcoder-weather.txt", encoding="utf-8") as fh:
            self.assertEqual(fh.read().strip(), "播报正文")


class ConfigResolveTests(unittest.TestCase):
    """定制项解析：默认值 < 配置文件 < 命令行。"""

    def test_defaults_are_untouched(self):
        cfg = wd.resolve_config()
        self.assertEqual(cfg["CITY"], "北京")
        self.assertEqual(cfg["NTFY_TOPIC"], wd.CONFIG["NTFY_TOPIC"])
        self.assertEqual(cfg["NTFY_TITLE"], wd.CONFIG["NTFY_TITLE"])
        self.assertFalse(cfg["DETAIL"])
        self.assertFalse(cfg["DRY_RUN"])
        self.assertFalse(cfg["NO_DEDUPE"])

    def test_city_preset_fills_coordinates_timezone_and_title(self):
        cfg = wd.resolve_config({"city": "上海"})
        self.assertEqual(cfg["CITY"], "上海")
        self.assertAlmostEqual(cfg["LAT"], 31.2304)
        self.assertAlmostEqual(cfg["LON"], 121.4737)
        self.assertEqual(cfg["TZ"], "Asia/Shanghai")
        self.assertEqual(cfg["NTFY_TITLE"], "明日天气 · 上海")

    def test_unknown_city_is_rejected(self):
        with self.assertRaises(ValueError):
            wd.resolve_config({"city": "不存在市"})

    def test_unknown_city_is_allowed_with_explicit_coordinates(self):
        """没有预设的城市名只是显示标签，配上经纬度就该放行。"""
        cfg = wd.resolve_config({"city": "我老家", "lat": 28.1, "lon": 112.9})
        self.assertEqual(cfg["CITY"], "我老家")
        self.assertAlmostEqual(cfg["LAT"], 28.1)
        self.assertAlmostEqual(cfg["LON"], 112.9)

    def test_explicit_coordinates_win_over_preset(self):
        cfg = wd.resolve_config({"city": "上海", "lat": 30.0, "lon": 120.0})
        self.assertAlmostEqual(cfg["LAT"], 30.0)
        self.assertAlmostEqual(cfg["LON"], 120.0)

    def test_explicit_title_wins_over_generated(self):
        cfg = wd.resolve_config({"city": "上海", "title": "我的标题"})
        self.assertEqual(cfg["NTFY_TITLE"], "我的标题")

    def test_unknown_config_key_is_rejected(self):
        with self.assertRaises(ValueError):
            wd.resolve_config({"nope": 1})

    def test_config_file_is_merged_and_cli_wins(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8",
                                         delete=False) as fh:
            json.dump({"city": "上海", "footer": "文件里的备注", "detail": True}, fh)
            path = fh.name
        self.addCleanup(os.remove, path)

        cfg = wd.resolve_config({"config_file": path, "footer": "命令行的备注"})
        self.assertEqual(cfg["CITY"], "上海")
        self.assertTrue(cfg["DETAIL"])
        self.assertEqual(cfg["FOOTER"], "命令行的备注")


class ForecastUrlTests(unittest.TestCase):
    def test_default_url_is_byte_identical_to_history(self):
        """默认请求必须和定制前逐字节一致，否则 cron 路径随时可能回归。"""
        cfg = wd.resolve_config()
        self.assertEqual(
            wd.forecast_url(cfg),
            "https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074"
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,"
            "precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant"
            "&timezone=Asia/Shanghai&forecast_days=3")

    def test_detail_url_adds_extra_fields_only(self):
        cfg = wd.resolve_config({"detail": True})
        url = wd.forecast_url(cfg, detail=True)
        self.assertIn("apparent_temperature_max", url)
        self.assertIn("sunrise", url)
        self.assertIn("weather_code", url)


class DetailTests(unittest.TestCase):
    @staticmethod
    def detail_payload():
        payload = json.loads(daily_payload())
        payload["daily"]["apparent_temperature_min"] = [6.0, 7.5, 9.0]
        payload["daily"]["apparent_temperature_max"] = [14.0, 16.0, 13.0]
        payload["daily"]["uv_index_max"] = [2.0, 5.0, 3.0]
        payload["daily"]["precipitation_sum"] = [0.0, 2.4, 1.0]
        payload["daily"]["wind_gusts_10m_max"] = [20.0, 25.5, 18.0]
        payload["daily"]["sunrise"] = ["2026-10-23T06:10", "2026-10-24T06:12",
                                       "2026-10-25T06:14"]
        payload["daily"]["sunset"] = ["2026-10-23T17:20", "2026-10-24T17:18",
                                      "2026-10-25T17:16"]
        return json.dumps(payload).encode()

    def build(self, payload, **kwargs):
        with mock.patch.object(wd, "fetch", return_value=payload):
            return wd.build("http://unused", **kwargs)

    def test_detail_rows_rendered(self):
        body = self.build(self.detail_payload(), detail=True)
        self.assertIn("体感：7.5~16.0°C", body)
        self.assertIn("紫外线：5.0（中等）", body)
        self.assertIn("降水量：2.4mm", body)
        self.assertIn("阵风：25.5km/h", body)
        self.assertIn("日出日落：06:12 / 17:18", body)

    def test_missing_detail_fields_do_not_crash(self):
        body = self.build(daily_payload(), detail=True)
        self.assertIn("天气：", body)
        self.assertNotIn("体感：", body)

    def test_footer_is_appended(self):
        body = self.build(daily_payload(), footer="记得带伞")
        self.assertTrue(body.endswith("备注：记得带伞"))

    def test_city_override_appears_in_header(self):
        cfg = wd.resolve_config({"city": "上海"})
        self.assertIn("· 上海】", self.build(daily_payload(), cfg=cfg))


class CustomizationRunTests(unittest.TestCase):
    def setUp(self):
        self.state = os.path.join(os.path.dirname(MODULE_PATH), ".test-customize-state")
        self.patch = mock.patch.object(wd, "STATE_FILE", self.state)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        if os.path.exists(self.state):
            os.remove(self.state)

    def tearDown(self):
        if os.path.exists(self.state):
            os.remove(self.state)

    def run_main(self, **overrides):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = wd.main(overrides=overrides or None)
        return code, buf.getvalue()

    def test_dry_run_never_pushes_and_never_marks_state(self):
        with mock.patch.object(wd, "build", return_value="正文"), \
             mock.patch.object(wd, "push", side_effect=AssertionError("试运行不应推送")):
            code, out = self.run_main(dry_run=True)
        self.assertEqual(code, 0)
        self.assertIn("试运行", out)
        self.assertFalse(wd.already_pushed_today(self.state))

    def test_no_dedupe_pushes_even_when_pushed_today(self):
        with open(self.state, "w", encoding="utf-8") as fh:
            fh.write(datetime.date.today().isoformat())
        with mock.patch.object(wd, "build", return_value="正文"), \
             mock.patch.object(wd, "push", return_value=200):
            code, out = self.run_main(no_dedupe=True)
        self.assertEqual(code, 0)
        self.assertIn("已推送到手机", out)

    def test_custom_topic_and_title_reach_the_request(self):
        cfg = wd.resolve_config({"topic": "my-topic", "title": "我的标题"})
        payload = json.loads(wd.build_request("正文", cfg=cfg).data.decode("utf-8"))
        self.assertEqual(payload["topic"], "my-topic")
        self.assertEqual(payload["title"], "我的标题")


class CliTests(unittest.TestCase):
    def test_no_flags_produce_no_overrides(self):
        self.assertEqual(wd.options_to_overrides(wd.parse_args([])), {})

    def test_flags_map_to_override_keys(self):
        overrides = wd.options_to_overrides(
            wd.parse_args(["--city", "上海", "--detail", "--footer", "带伞", "--dry-run"]))
        self.assertEqual(overrides["city"], "上海")
        self.assertTrue(overrides["detail"])
        self.assertEqual(overrides["footer"], "带伞")
        self.assertTrue(overrides["dry_run"])


class IsolatedDefaultConfig(unittest.TestCase):
    """把默认配置文件指向临时目录，避免用户真实配置影响断言。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.config_path = os.path.join(self.dir, "weather-daily.json")
        self.patch = mock.patch.object(wd, "DEFAULT_CONFIG_FILE", self.config_path)
        self.patch.start()
        self.addCleanup(self.patch.stop)


class PersistentConfigTests(IsolatedDefaultConfig):
    """持久化定制：默认配置文件自动生效 + --set 写入。"""

    def test_missing_default_config_file_uses_builtin_defaults(self):
        self.assertEqual(wd.resolve_config()["CITY"], "北京")

    def test_default_config_file_is_auto_loaded(self):
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump({"city": "上海", "detail": True}, fh)
        cfg = wd.resolve_config()
        self.assertEqual(cfg["CITY"], "上海")
        self.assertTrue(cfg["DETAIL"])
        self.assertAlmostEqual(cfg["LAT"], 31.2304)

    def test_broken_default_config_file_degrades_to_defaults(self):
        """默认配置文件在 cron 关键路径上，坏了必须降级而不是让播报停摆。"""
        with open(self.config_path, "w", encoding="utf-8") as fh:
            fh.write("{不是 json")
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            cfg = wd.resolve_config()
        self.assertEqual(cfg["CITY"], "北京")
        self.assertIn("默认配置文件", buf.getvalue())

    def test_cli_overrides_default_config_file(self):
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump({"city": "上海", "footer": "文件里的"}, fh)
        cfg = wd.resolve_config({"footer": "命令行的"})
        self.assertEqual(cfg["CITY"], "上海")
        self.assertEqual(cfg["FOOTER"], "命令行的")

    def test_load_files_false_ignores_config_file(self):
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump({"city": "上海"}, fh)
        self.assertEqual(wd.resolve_config(load_files=False)["CITY"], "北京")

    def test_apply_set_creates_then_merges(self):
        target, data = wd.apply_set(["city=上海"], self.config_path)
        self.assertEqual(target, self.config_path)
        self.assertEqual(data["city"], "上海")
        with open(self.config_path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["city"], "上海")

        _, data = wd.apply_set(["detail=true"], self.config_path)
        self.assertEqual(data["city"], "上海")
        self.assertIs(data["detail"], True)

    def test_apply_set_rejects_unknown_key(self):
        with self.assertRaises(ValueError):
            wd.apply_set(["nope=1"], self.config_path)

    def test_apply_set_rejects_malformed_pair(self):
        with self.assertRaises(ValueError):
            wd.apply_set(["city"], self.config_path)

    def test_set_value_coercion(self):
        data = wd.parse_set_values(["detail=true", "no_dedupe=false", "lat=31.23",
                                    "footer=带伞"])
        self.assertIs(data["detail"], True)
        self.assertIs(data["no_dedupe"], False)
        self.assertAlmostEqual(data["lat"], 31.23)
        self.assertEqual(data["footer"], "带伞")


class StatePathTests(IsolatedDefaultConfig):
    """去重状态文件：默认城市沿用历史文件名，其他城市各自一份。"""

    def test_default_city_keeps_historical_file(self):
        self.assertEqual(wd.state_path(wd.resolve_config()), wd.STATE_FILE)

    def test_other_city_gets_its_own_state_file(self):
        cfg = wd.resolve_config({"city": "上海"})
        self.assertEqual(wd.state_path(cfg), f"{wd.STATE_FILE}.上海")

    def test_explicit_state_file_wins(self):
        cfg = wd.resolve_config({"city": "上海", "state_file": "/tmp/custom-state"})
        self.assertEqual(wd.state_path(cfg), "/tmp/custom-state")


class CronTests(IsolatedDefaultConfig):
    def test_default_cron_line_matches_installed_entry(self):
        """生成的行必须和已装 crontab 一致：UTC 08:40 = 北京 16:40。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            wd.print_cron(wd.resolve_config(), "16:40")
        out = buf.getvalue()
        self.assertIn("40 8 * * *", out)
        self.assertIn("weather-daily.py", out)
        self.assertIn(">> ", out)

    def test_cron_flags_are_empty_for_defaults(self):
        self.assertEqual(wd.cron_flags(wd.resolve_config()), [])

    def test_cron_flags_reflect_customization(self):
        flags = wd.cron_flags(wd.resolve_config({"city": "上海", "detail": True}))
        self.assertIn("--city", flags)
        self.assertIn("--detail", flags)
        self.assertIn("上海", shlex.split(" ".join(flags)))

    def test_cron_flags_skip_derived_title(self):
        """标题由城市派生时不能再写进 crontab 行。"""
        flags = wd.cron_flags(wd.resolve_config({"city": "上海"}))
        self.assertNotIn("--title", flags)

    def test_cron_flags_quote_values_with_spaces(self):
        """cron 交给 /bin/sh 执行，值里的空格必须转义，否则参数会被拆开。"""
        flags = wd.cron_flags(wd.resolve_config({"footer": "记得 带伞"}))
        self.assertIn("'记得 带伞'", flags)

    def test_generated_cron_line_is_valid_shell(self):
        cfg = wd.resolve_config({"city": "上海", "detail": True, "footer": "记得 带伞"})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            wd.print_cron(cfg, "16:40")
        line = [ln for ln in buf.getvalue().splitlines() if ln and not ln.startswith("#")][-1]
        # 解析后 footer 必须是一个完整参数，而不是被空格拆开
        parts = shlex.split(line.split(" * * * ", 1)[1].split(" >> ")[0])
        self.assertIn("记得 带伞", parts)

    def test_cron_time_validation(self):
        with self.assertRaises(ValueError):
            wd.print_cron(wd.resolve_config(), "25:00")
        with self.assertRaises(ValueError):
            wd.print_cron(wd.resolve_config(), "abc")

    def test_cron_line_does_not_freeze_config_file_customization(self):
        """配置文件里的定制不能写进 crontab 行，否则用户事后改配置就不生效。"""
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump({"city": "上海"}, fh)
        effective = wd.resolve_config()
        cli_only = wd.resolve_config({}, load_files=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            wd.print_cron(effective, "16:40", cli_cfg=cli_only)
        out = buf.getvalue()
        line = [ln for ln in out.splitlines() if ln and not ln.startswith("#")][-1]
        self.assertNotIn("--city", line)
        self.assertIn(self.config_path, out)

    def test_cron_flags_include_relocated_config_path(self):
        cfg = wd.resolve_config({"config_path": "/tmp/wx.json"}, load_files=False)
        flags = wd.cron_flags(cfg)
        self.assertIn("--config-path", flags)
        self.assertIn("/tmp/wx.json", flags)

    def test_show_config_emits_json_with_state_file(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            wd.show_config(wd.resolve_config())
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["config"]["CITY"], "北京")
        self.assertEqual(payload["state_file"], wd.STATE_FILE)
        self.assertIn("api.open-meteo.com", payload["url"])


class MultiDayTests(unittest.TestCase):
    """多日预报：接口本来就取 3 天，脚本原本只用了 1 天。"""

    def build(self, payload, **kwargs):
        with mock.patch.object(wd, "fetch", return_value=payload):
            return wd.build("http://unused", **kwargs)

    def test_single_day_output_is_unchanged(self):
        """--days 1 的输出必须和定制前逐字一致，否则每天的播报就变了。"""
        body = self.build(daily_payload())
        self.assertEqual(body, "\n".join([
            "【2026-10-24 星期六 · 北京】",
            "天气：小雨",
            "气温：8.5~17.1°C",
            "降水概率：80%   ← 记得带伞",
            "风：北轻风（8.2km/h）",
            "对比今天：7.1~15.9°C，明天较今天低1°C",
            "建议：气温偏低，注意保暖添衣。",
        ]))

    def test_two_days_render_two_blocks(self):
        body = self.build(daily_payload(), days=2)
        blocks = body.split("\n\n")
        self.assertEqual(len(blocks), 2)
        self.assertIn("【2026-10-24 星期六 · 北京】", blocks[0])
        self.assertIn("【2026-10-25 星期日 · 北京】", blocks[1])
        self.assertIn("明天较今天", blocks[0])
        self.assertIn("后天较今天", blocks[1])

    def test_each_block_uses_its_own_day_values(self):
        body = self.build(daily_payload(), days=2)
        blocks = body.split("\n\n")
        self.assertIn("8.5~17.1°C", blocks[0])   # 明天
        self.assertIn("10.0~14.1°C", blocks[1])  # 后天
        self.assertIn("小雨", blocks[0])
        self.assertIn("毛毛雨", blocks[1])

    def test_days_beyond_payload_are_truncated_not_fatal(self):
        body = self.build(daily_payload(), days=5)
        self.assertEqual(len(body.split("\n\n")), 2)

    def test_footer_lands_after_last_block(self):
        body = self.build(daily_payload(), days=2, footer="记得带伞")
        self.assertTrue(body.endswith("备注：记得带伞"))
        self.assertEqual(body.count("备注："), 1)

    def test_forecast_days_grows_with_days(self):
        cfg = wd.resolve_config()
        self.assertIn("forecast_days=3", wd.forecast_url(cfg))
        self.assertIn("forecast_days=3", wd.forecast_url(cfg, days=2))
        self.assertIn("forecast_days=4", wd.forecast_url(cfg, days=3))

    def test_days_out_of_range_is_rejected(self):
        with self.assertRaises(ValueError):
            wd.resolve_config({"days": 0})
        with self.assertRaises(ValueError):
            wd.resolve_config({"days": 99})
        with self.assertRaises(ValueError):
            wd.resolve_config({"days": "3"})

    def test_cron_flags_include_days(self):
        flags = wd.cron_flags(wd.resolve_config({"days": 3}))
        self.assertIn("--days", flags)
        self.assertIn("3", flags)


if __name__ == "__main__":
    unittest.main(verbosity=2)
