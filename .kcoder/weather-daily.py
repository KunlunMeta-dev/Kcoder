#!/usr/bin/env python3
"""每日次日天气播报：取数 -> 解析 -> 推送 ntfy -> 打印。

由 cron 任务调用（每日 16:40 Asia/Shanghai）。
默认行为与定制之前完全一致：默认城市、默认格式、默认去重、默认退出码。
所有定制项都走命令行参数或 JSON 配置文件，不必改代码。

用法：
  python3 weather-daily.py                     # 默认：明天的北京天气，推送
  python3 weather-daily.py --city 上海         # 换城市（内置预设）
  python3 weather-daily.py --lat 31.23 --lon 121.47 --tz Asia/Shanghai
  python3 weather-daily.py --detail            # 追加体感/紫外线/降水/阵风/日出日落
  python3 weather-daily.py --days 3            # 播报未来 3 天（默认只播明天）
  python3 weather-daily.py --footer "记得带伞"  # 追加一行自定义备注
  python3 weather-daily.py --dry-run           # 只取数打印，不推送、不落地
  python3 weather-daily.py --no-dedupe        # 忽略当日去重（换城市时的手动补推）
  python3 weather-daily.py --list-cities       # 列出内置城市预设
  python3 weather-daily.py --config my.json    # 从 JSON 文件读定制项
  python3 weather-daily.py --show-config       # 打印生效配置（不联网）
  python3 weather-daily.py --print-cron        # 打印对应的 crontab 行（不联网）
  python3 weather-daily.py --set city=上海      # 写入默认配置文件并退出（不播报）
  python3 weather-daily.py --help              # 全部参数

持久化定制：默认配置文件 weather-daily.json（与本脚本同目录）存在时自动生效，
改一次长期有效，不必再动 crontab。--set 直接写它，--config-path 可换位置。

配置优先级：内置默认值 < 默认配置文件 < --config 文件 < 命令行参数。
退出码：0 成功（推送成功 / 今日已推送跳过 / 试运行）；2 取数失败或配置错误；3 取数成功但推送失败。
"""

import argparse
import datetime
import json
import os
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request

CONFIG = {
    "CITY": "北京",
    "LAT": 39.9042,
    "LON": 116.4074,
    "TZ": "Asia/Shanghai",
    "NTFY_TOPIC": "kcoder-wx-irbrpuvx",
    "NTFY_TITLE": "明日天气 · 北京",
}

# 记录当天是否已推送，避免 KCoder automation 与系统 crontab 两个触发源
# 同时命中时重复打扰手机。--force 可跳过该保护。
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".weather-last-push")

DEFAULT_OUTPUT = "/tmp/kcoder-weather.txt"

# Persistent customization file, auto-loaded when it exists next to the script.
# It is the "set it once" knob: the cron entry keeps calling the script with no
# arguments, so changing the city never means editing the crontab.
DEFAULT_CONFIG_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "weather-daily.json")

# 内置城市预设：名称 -> (纬度, 经度, 时区)。城市名只是显示用的，
# 真正的定位靠经纬度；换城市时同步改 CITY / LAT / LON 这三处的坑由此消除。
CITY_PRESETS = {
    "北京": (39.9042, 116.4074, "Asia/Shanghai"),
    "上海": (31.2304, 121.4737, "Asia/Shanghai"),
    "广州": (23.1291, 113.2644, "Asia/Shanghai"),
    "深圳": (22.5431, 114.0579, "Asia/Shanghai"),
    "杭州": (30.2741, 120.1551, "Asia/Shanghai"),
    "南京": (32.0603, 118.7969, "Asia/Shanghai"),
    "苏州": (31.2989, 120.5853, "Asia/Shanghai"),
    "成都": (30.5728, 104.0668, "Asia/Shanghai"),
    "重庆": (29.5630, 106.5516, "Asia/Shanghai"),
    "武汉": (30.5928, 114.3055, "Asia/Shanghai"),
    "西安": (34.3416, 108.9398, "Asia/Shanghai"),
    "天津": (39.3434, 117.3616, "Asia/Shanghai"),
    "长沙": (28.2282, 112.9388, "Asia/Shanghai"),
    "青岛": (36.0671, 120.3826, "Asia/Shanghai"),
    "济南": (36.6512, 117.1201, "Asia/Shanghai"),
    "郑州": (34.7466, 113.6254, "Asia/Shanghai"),
    "沈阳": (41.8057, 123.4315, "Asia/Shanghai"),
    "大连": (38.9140, 121.6147, "Asia/Shanghai"),
    "哈尔滨": (45.8038, 126.5349, "Asia/Shanghai"),
    "长春": (43.8171, 125.3235, "Asia/Shanghai"),
    "昆明": (25.0389, 102.7183, "Asia/Shanghai"),
    "贵阳": (26.6470, 106.6302, "Asia/Shanghai"),
    "南宁": (22.8170, 108.3665, "Asia/Shanghai"),
    "厦门": (24.4798, 118.0894, "Asia/Shanghai"),
    "福州": (26.0745, 119.2965, "Asia/Shanghai"),
    "合肥": (31.8206, 117.2272, "Asia/Shanghai"),
    "南昌": (28.6820, 115.8579, "Asia/Shanghai"),
    "石家庄": (38.0428, 114.5149, "Asia/Shanghai"),
    "太原": (37.8706, 112.5489, "Asia/Shanghai"),
    "兰州": (36.0611, 103.8343, "Asia/Shanghai"),
    "乌鲁木齐": (43.8256, 87.6168, "Asia/Shanghai"),
    "拉萨": (29.6520, 91.1721, "Asia/Shanghai"),
    "海口": (20.0444, 110.1999, "Asia/Shanghai"),
    "三亚": (18.2528, 109.5119, "Asia/Shanghai"),
    "香港": (22.3193, 114.1694, "Asia/Hong_Kong"),
    "澳门": (22.1987, 113.5439, "Asia/Macau"),
    "台北": (25.0330, 121.5654, "Asia/Taipei"),
    "高雄": (22.6273, 120.3014, "Asia/Taipei"),
    "东京": (35.6762, 139.6503, "Asia/Tokyo"),
    "大阪": (34.6937, 135.5023, "Asia/Tokyo"),
    "首尔": (37.5665, 126.9780, "Asia/Seoul"),
    "新加坡": (1.3521, 103.8198, "Asia/Singapore"),
    "曼谷": (13.7563, 100.5018, "Asia/Bangkok"),
    "纽约": (40.7128, -74.0060, "America/New_York"),
    "洛杉矶": (34.0522, -118.2437, "America/Los_Angeles"),
    "旧金山": (37.7749, -122.4194, "America/Los_Angeles"),
    "多伦多": (43.6532, -79.3832, "America/Toronto"),
    "伦敦": (51.5074, -0.1278, "Europe/London"),
    "巴黎": (48.8566, 2.3522, "Europe/Paris"),
    "柏林": (52.5200, 13.4050, "Europe/Berlin"),
    "莫斯科": (55.7558, 37.6173, "Europe/Moscow"),
    "悉尼": (-33.8688, 151.2093, "Australia/Sydney"),
    "墨尔本": (-37.8136, 144.9631, "Australia/Melbourne"),
    "迪拜": (25.2048, 55.2708, "Asia/Dubai"),
}

WMO = {
    0: "晴", 1: "大部晴朗", 2: "局部多云", 3: "阴/多云",
    45: "雾", 48: "雾",
    51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨", 56: "冻毛毛雨", 57: "冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "阵雪",
    95: "雷阵雨", 96: "雷暴伴冰雹", 99: "雷暴伴冰雹",
}

DIRECTIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]

# 多日预报时每天的相对称呼
DAY_LABELS = ["明天", "后天", "大后天", "第4天", "第5天", "第6天", "第7天"]

# Default daily fields keep the original request byte-for-byte so the cron
# path cannot regress because of a new API parameter.
DAILY_FIELDS = ("weather_code,temperature_2m_max,temperature_2m_min,"
                "precipitation_probability_max,wind_speed_10m_max,"
                "wind_direction_10m_dominant")

# Extra fields are only requested in --detail mode, so an upstream API change
# can only break the opt-in path, never the daily broadcast itself.
DETAIL_FIELDS = (DAILY_FIELDS + ",apparent_temperature_max,apparent_temperature_min,"
                 "uv_index_max,precipitation_sum,wind_gusts_10m_max,sunrise,sunset")

# Override key -> internal config key. Same names are accepted in JSON files.
KEY_MAP = {
    "city": "CITY",
    "lat": "LAT",
    "lon": "LON",
    "tz": "TZ",
    "topic": "NTFY_TOPIC",
    "title": "NTFY_TITLE",
    "detail": "DETAIL",
    "footer": "FOOTER",
    "output": "OUTPUT",
    "state_file": "STATE_FILE",
    "dry_run": "DRY_RUN",
    "no_dedupe": "NO_DEDUPE",
    "days": "DAYS",
}


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "kcoder-weather/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        return resp.read()


def wind_dir(deg):
    return DIRECTIONS[round((deg % 360) / 45) % 8]


def wind_force(kmh):
    for limit, label in ((1, "无风"), (6, "软风"), (12, "轻风"), (20, "微风"),
                         (29, "和风"), (39, "强风")):
        if kmh < limit:
            return label
    return "大风"


def advice(mn, mx):
    if mn < 10:
        return "气温偏低，注意保暖添衣。"
    if mx - mn >= 8:
        return "白天较暖，建议短袖；早晚温差大请带件薄外套。"
    return "温度舒适，按日常穿着即可。"


def uv_label(uv):
    if uv < 3:
        return "弱"
    if uv < 6:
        return "中等"
    if uv < 8:
        return "较强"
    return "很强"


def _opt(daily, key, index):
    """Read an optional daily field, tolerating both missing keys and short arrays."""
    try:
        return daily[key][index]
    except (KeyError, IndexError, TypeError):
        return None


def detail_lines(daily, index):
    """Extra rows for --detail. Missing fields are skipped, never fatal."""
    lines = []

    amin = _opt(daily, "apparent_temperature_min", index)
    amax = _opt(daily, "apparent_temperature_max", index)
    if amin is not None and amax is not None:
        lines.append(f"体感：{amin}~{amax}°C")

    uv = _opt(daily, "uv_index_max", index)
    if uv is not None:
        lines.append(f"紫外线：{uv}（{uv_label(uv)}）")

    precip = _opt(daily, "precipitation_sum", index)
    if precip is not None:
        lines.append(f"降水量：{precip}mm")

    gust = _opt(daily, "wind_gusts_10m_max", index)
    if gust is not None:
        lines.append(f"阵风：{gust}km/h")

    sunrise = _opt(daily, "sunrise", index)
    sunset = _opt(daily, "sunset", index)
    if sunrise and sunset:
        lines.append(f"日出日落：{str(sunrise)[11:16]} / {str(sunset)[11:16]}")

    return lines


def build_day(daily, index, cfg, label="明天", detail=False):
    """渲染某一天的播报块。index 0 是今天，1 是明天。"""
    day = daily["time"][index]
    date = datetime.date.fromisoformat(day)
    weekday = "星期" + "一二三四五六日"[date.weekday()]

    code = daily["weather_code"][index]
    mn, mx = daily["temperature_2m_min"][index], daily["temperature_2m_max"][index]
    pop = daily["precipitation_probability_max"][index]
    wsh = daily["wind_speed_10m_max"][index]
    wdir = daily["wind_direction_10m_dominant"][index]
    cmn, cmx = daily["temperature_2m_min"][0], daily["temperature_2m_max"][0]

    delta = ((cmn + cmx) / 2) - ((mn + mx) / 2)
    if abs(delta) < 1:
        compare = "基本持平"
    else:
        compare = f"{'高' if delta > 0 else '低'}{abs(round(delta))}°C"

    hint = "记得带伞" if pop >= 40 else "无需带伞"

    lines = [
        f"【{day} {weekday} · {cfg['CITY']}】",
        f"天气：{WMO.get(code, f'代码{code}')}",
        f"气温：{mn}~{mx}°C",
        f"降水概率：{pop}%   ← {hint}",
        f"风：{wind_dir(wdir)}{wind_force(wsh)}（{wsh}km/h）",
        f"对比今天：{cmn}~{cmx}°C，{label}较今天{compare}",
        f"建议：{advice(mn, mx)}",
    ]

    if detail:
        lines.extend(detail_lines(daily, index))

    return lines


def build(url, cfg=None, detail=False, footer=None, days=1):
    cfg = cfg or CONFIG
    daily = json.loads(fetch(url))["daily"]
    if len(daily.get("time", [])) < 2:
        raise RuntimeError("daily 数组缺少明天字段")

    blocks = []
    for offset in range(max(1, days)):
        index = 1 + offset
        if index >= len(daily["time"]):
            break  # 接口没给那么多天就到这儿为止，不算失败
        label = DAY_LABELS[offset] if offset < len(DAY_LABELS) else f"第{offset + 1}天"
        blocks.append("\n".join(build_day(daily, index, cfg, label, detail)))

    body = "\n\n".join(blocks)
    if footer:
        body += f"\n备注：{footer}"
    return body


def build_request(body, cfg=None):
    """构造 ntfy JSON 发布请求。

    标题和正文都放 JSON body，不放 HTTP header —— HTTP 头必须 latin-1
    可编码，中文 Title 头会让 http.client 抛 UnicodeEncodeError。
    （curl 能过是因为它不校验、直接发 UTF-8 字节，别被那个误导。）
    """
    cfg = cfg or CONFIG
    payload = json.dumps({
        "topic": cfg["NTFY_TOPIC"],
        "title": cfg["NTFY_TITLE"],
        "message": body,
    }, ensure_ascii=False).encode("utf-8")

    return urllib.request.Request(
        "https://ntfy.sh/",
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )


def push(body, cfg=None):
    with urllib.request.urlopen(build_request(body, cfg=cfg), timeout=20) as resp:
        return resp.status


def already_pushed_today(state_file=None):
    """今天是否已经推送过。状态文件损坏时视为未推送（宁可多推一次也不要漏推）。"""
    try:
        with open(state_file or STATE_FILE, encoding="utf-8") as fh:
            return fh.read().strip() == datetime.date.today().isoformat()
    except OSError:
        return False


def mark_pushed(state_file=None):
    try:
        with open(state_file or STATE_FILE, "w", encoding="utf-8") as fh:
            fh.write(datetime.date.today().isoformat() + "\n")
    except OSError as exc:
        # 去重写不进去只影响去重，不该让整次推送失败
        print(f"⚠️ 去重状态写入失败：{exc}", file=sys.stderr)


def load_config_file(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("配置文件顶层必须是 JSON 对象")
    return {str(k).lower(): v for k, v in data.items()}


def base_config():
    """Built-in defaults only. No file is read, so it can serve as a diff base."""
    cfg = dict(CONFIG)
    cfg.update({
        "DETAIL": False,
        "FOOTER": "",
        "OUTPUT": DEFAULT_OUTPUT,
        "STATE_FILE": STATE_FILE,
        "DRY_RUN": False,
        "NO_DEDUPE": False,
        "DAYS": 1,
        "STATE_FILE_EXPLICIT": False,
        "CONFIG_PATH": DEFAULT_CONFIG_FILE,
        "CONFIG_FILE": None,
    })
    return cfg


def resolve_config(overrides=None, load_files=True):
    """合并配置：内置默认值 < 默认配置文件 < --config 文件 < 命令行参数。

    load_files=False 时只合并命令行参数，用于生成 crontab 行——那行必须只
    带显式参数，否则用户事后改配置文件会被行内参数覆盖，定制就白改了。
    """
    cfg = base_config()

    overrides = {str(k).lower(): v for k, v in (overrides or {}).items() if v is not None}
    file_path = overrides.pop("config_file", None)
    auto_path = overrides.pop("config_path", None) or DEFAULT_CONFIG_FILE

    merged = {}
    # The auto-loaded file sits on the cron's critical path. A broken file must
    # degrade to defaults with a warning, never break the daily broadcast.
    if load_files and os.path.exists(auto_path):
        try:
            merged.update(load_config_file(auto_path))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"⚠️ 默认配置文件读取失败（已忽略，继续用默认值）：{exc}", file=sys.stderr)
    if load_files and file_path:
        merged.update(load_config_file(file_path))
    merged.update(overrides)

    for key, value in merged.items():
        if key not in KEY_MAP:
            raise ValueError(f"未知配置项：{key}")
        cfg[KEY_MAP[key]] = value

    cfg["STATE_FILE_EXPLICIT"] = "state_file" in merged
    cfg["CONFIG_PATH"] = auto_path
    cfg["CONFIG_FILE"] = file_path

    # 城市预设：给了城市名就带出经纬度和时区，除非显式给了经纬度。
    if "city" in merged:
        city = cfg["CITY"]
        preset = CITY_PRESETS.get(city)
        if preset is None:
            # 没有预设的城市名只是显示标签，必须自己给出经纬度
            if "lat" not in merged or "lon" not in merged:
                raise ValueError(
                    f"未知城市：{city}（--list-cities 看内置预设，"
                    f"或同时给出 --lat/--lon 自定义）")
        else:
            lat, lon, tz = preset
            if "lat" not in merged:
                cfg["LAT"] = lat
            if "lon" not in merged:
                cfg["LON"] = lon
            if "tz" not in merged:
                cfg["TZ"] = tz
            if "title" not in merged:
                cfg["NTFY_TITLE"] = f"明日天气 · {city}"

    days = cfg["DAYS"]
    if isinstance(days, bool) or not isinstance(days, int):
        raise ValueError(f"days 必须是整数，收到：{days!r}")
    if days < 1 or days > len(DAY_LABELS):
        raise ValueError(f"days 必须在 1..{len(DAY_LABELS)} 之间，收到：{days}")

    return cfg


def state_path(cfg):
    """去重状态文件路径。

    默认城市沿用历史文件名，现有的去重记录不失效；其他城市各自一个文件，
    否则先跑的城市会把后跑城市的定时推送挡掉。
    """
    if cfg.get("STATE_FILE_EXPLICIT"):
        return cfg["STATE_FILE"]
    if cfg["CITY"] != CONFIG["CITY"]:
        return f"{cfg['STATE_FILE']}.{cfg['CITY']}"
    return cfg["STATE_FILE"]



def forecast_url(cfg, detail=False, days=1):
    fields = DETAIL_FIELDS if detail else DAILY_FIELDS
    forecast_days = max(3, days + 1)  # [0] 是今天，还要留出播报的那几天
    return (
        f"https://api.open-meteo.com/v1/forecast?latitude={cfg['LAT']}"
        f"&longitude={cfg['LON']}"
        f"&daily={fields}"
        f"&timezone={urllib.parse.quote(cfg['TZ'])}&forecast_days={forecast_days}"
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="weather-daily.py",
        description="次日天气播报（不传参数时行为与历史完全一致）",
    )
    parser.add_argument("--city", help="城市名，内置预设见 --list-cities")
    parser.add_argument("--lat", type=float, help="纬度，覆盖城市预设")
    parser.add_argument("--lon", type=float, help="经度，覆盖城市预设")
    parser.add_argument("--tz", help="时区，如 Asia/Shanghai")
    parser.add_argument("--topic", help="ntfy topic")
    parser.add_argument("--title", help="ntfy 标题，默认「明日天气 · 城市」")
    parser.add_argument("--days", type=int,
                        help="播报未来几天，默认 1（只播明天），最多 7")
    parser.add_argument("--detail", action="store_true", default=None,
                        help="追加体感/紫外线/降水量/阵风/日出日落")
    parser.add_argument("--footer", help="追加一行自定义备注")
    parser.add_argument("--output", help=f"播报落盘路径，默认 {DEFAULT_OUTPUT}")
    parser.add_argument("--state-file", help="去重状态文件路径")
    parser.add_argument("--config", dest="config_file",
                        help="JSON 配置文件，键名与本命令参数同名")
    parser.add_argument("--dry-run", action="store_true", default=None,
                        help="只取数打印，不推送、不写状态、不落盘")
    parser.add_argument("--no-dedupe", action="store_true", default=None,
                        help="忽略当日去重状态（换城市时的手动补推）")
    parser.add_argument("--force", action="store_true",
                        help="忽略当日去重并强制重推（历史兼容参数）")
    parser.add_argument("--list-cities", action="store_true",
                        help="列出内置城市预设后退出")
    parser.add_argument("--set", action="append", dest="sets", metavar="KEY=VALUE",
                        help="写入默认配置文件后退出，不播报；可重复")
    parser.add_argument("--config-path", dest="config_path",
                        help="默认配置文件路径，默认为脚本同目录 weather-daily.json")
    parser.add_argument("--show-config", action="store_true",
                        help="打印生效配置后退出，不联网")
    parser.add_argument("--print-cron", action="store_true",
                        help="打印对应的 crontab 行后退出，不联网")
    parser.add_argument("--cron-time", default="16:40",
                        help="--print-cron 使用的北京时间，默认 16:40")
    return parser.parse_args(argv)


def options_to_overrides(opts):
    mapping = {
        "city": "city", "lat": "lat", "lon": "lon", "tz": "tz",
        "topic": "topic", "title": "title", "detail": "detail",
        "footer": "footer", "output": "output", "state_file": "state_file",
        "dry_run": "dry_run", "no_dedupe": "no_dedupe", "days": "days",
        "config_path": "config_path",
    }
    overrides = {}
    for attr, key in mapping.items():
        value = getattr(opts, attr, None)
        if value is not None:
            overrides[key] = value
    if getattr(opts, "config_file", None):
        overrides["config_file"] = opts.config_file
    return overrides


def coerce_value(raw):
    """把 --set 的字符串转成合适的 JSON 类型。"""
    text = raw.strip()
    low = text.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def parse_set_values(pairs):
    data = {}
    for item in pairs or []:
        if "=" not in item:
            raise ValueError(f"--set 需要 KEY=VALUE 形式，收到：{item}")
        key, value = item.split("=", 1)
        key = key.strip().lower()
        if key not in KEY_MAP:
            raise ValueError(
                f"未知配置项：{key}（可用：{', '.join(sorted(KEY_MAP))}）")
        data[key] = coerce_value(value)
    return data


def write_config_file(path, data):
    """原子写入配置文件，避免写一半被 cron 读到。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


CUSTOM_KEYS = ("CITY", "LAT", "LON", "TZ", "NTFY_TOPIC", "NTFY_TITLE", "FOOTER",
               "DETAIL", "DAYS")


def custom_diff(effective, cli_only):
    """生效配置里由配置文件带来的定制项（命令行之外的部分）。"""
    return {key: (cli_only.get(key), effective.get(key))
            for key in CUSTOM_KEYS
            if cli_only.get(key) != effective.get(key)}


def cron_flags(cfg):
    """把显式命令行定制转成 crontab 行里的参数。

    cron 把整行交给 /bin/sh 执行，参数值里的空格会被拆开，所以值必须转义。
    """
    base = base_config()
    flags = []

    def add(flag, value):
        flags.extend([flag, shlex.quote(str(value))])

    if cfg["CITY"] != base["CITY"]:
        add("--city", cfg["CITY"])
    else:
        for key, flag in (("LAT", "--lat"), ("LON", "--lon"), ("TZ", "--tz")):
            if cfg[key] != base[key]:
                add(flag, cfg[key])

    # 标题由城市自动派生时不用再写一遍，否则 crontab 行会多出无意义的参数。
    derived_title = f"明日天气 · {cfg['CITY']}"
    if cfg["NTFY_TITLE"] != base["NTFY_TITLE"] and cfg["NTFY_TITLE"] != derived_title:
        add("--title", cfg["NTFY_TITLE"])
    if cfg["NTFY_TOPIC"] != base["NTFY_TOPIC"]:
        add("--topic", cfg["NTFY_TOPIC"])
    if cfg["FOOTER"] != base["FOOTER"]:
        add("--footer", cfg["FOOTER"])
    if cfg["DAYS"] != base["DAYS"]:
        add("--days", cfg["DAYS"])
    if cfg["DETAIL"]:
        flags.append("--detail")
    if cfg["CONFIG_PATH"] != DEFAULT_CONFIG_FILE:
        add("--config-path", cfg["CONFIG_PATH"])
    return flags


def print_cron(cfg, cron_time="16:40", cli_cfg=None):
    """生成与现有主触发源格式一致的 crontab 行。

    本机 cron(3.0pl1) 不支持 CRON_TZ，所以这里换算成 UTC 时刻。
    行里只放显式命令行参数：配置文件带来的定制由脚本自己加载，
    写死进 crontab 反而会让用户事后改配置不生效。
    """
    try:
        hour, minute = (int(part) for part in cron_time.split(":"))
    except ValueError:
        raise ValueError(f"--cron-time 需要 HH:MM 形式，收到：{cron_time}")
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise ValueError(f"--cron-time 超出范围：{cron_time}")

    utc_hour = (hour - 8) % 24  # 北京时间 = UTC+8
    python = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable
    script = os.path.abspath(__file__)
    log = os.path.expanduser("~/.kcoder-weather.log")
    flags = cron_flags(cli_cfg if cli_cfg is not None else cfg)
    tail = (" " + " ".join(flags)) if flags else ""

    print(f"# 每天 {hour:02d}:{minute:02d} 北京时间 = UTC {utc_hour:02d}:{minute:02d} "
          f"推送次日天气到手机 ntfy")
    print("# 脚本自带当日去重，与 KCoder automation 触发源并存不会重复推送。")
    print(f"# 手动重推：{python} {script} --force")

    if cli_cfg is not None:
        diff = custom_diff(cfg, cli_cfg)
        if diff:
            source = cfg["CONFIG_FILE"] or cfg["CONFIG_PATH"]
            print(f"# 另有定制来自 {source}："
                  f"{', '.join(f'{k}={v[1]}' for k, v in sorted(diff.items()))}")
            print("# 改那个文件即可，crontab 这行不用动。")

    print(f"{minute} {utc_hour} * * * {python} {script}{tail} >> {log} 2>&1")


def show_config(cfg):
    payload = {
        "config": {k: v for k, v in cfg.items() if k != "STATE_FILE_EXPLICIT"},
        "state_file": state_path(cfg),
        "default_config_file": DEFAULT_CONFIG_FILE,
        "url": forecast_url(cfg, detail=cfg["DETAIL"], days=cfg["DAYS"]),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def print_cities():
    print("内置城市预设（--city 名称）：")
    for name, (lat, lon, tz) in CITY_PRESETS.items():
        print(f"  {name:<8} {lat:>9.4f}, {lon:>10.4f}  {tz}")


def main(force=False, overrides=None):
    try:
        cfg = resolve_config(overrides)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"配置错误：{exc}")
        return 2

    url = forecast_url(cfg, detail=cfg["DETAIL"], days=cfg["DAYS"])

    try:
        body = build(url, cfg=cfg, detail=cfg["DETAIL"], footer=cfg["FOOTER"],
                     days=cfg["DAYS"])
    except (urllib.error.URLError, KeyError, ValueError, RuntimeError, OSError) as exc:
        print(f"天气获取失败：{exc}")
        return 2

    if cfg["DRY_RUN"]:
        print(body)
        print("🧪 试运行：未推送、未落盘")
        return 0

    try:
        with open(cfg["OUTPUT"], "w", encoding="utf-8") as fh:
            fh.write(body + "\n")
    except OSError as exc:
        # 落盘失败不该让推送一起失败，那等于今天的播报也没了
        print(f"⚠️ 播报写入文件失败：{exc}", file=sys.stderr)

    state = state_path(cfg)
    skip_dedupe = force or cfg["NO_DEDUPE"]
    if not skip_dedupe and already_pushed_today(state):
        print(body)
        print("ℹ️ 今日已推送过，跳过（--force 可强制重推）")
        return 0

    try:
        code = push(body, cfg=cfg)
        ok = code == 200
        print(body)
        print("✅ 已推送到手机" if ok else f"⚠️ 手机推送失败：HTTP {code}")
        if ok:
            mark_pushed(state)
        return 0 if ok else 3
    except (urllib.error.URLError, OSError) as exc:
        print(body)
        print(f"⚠️ 手机推送失败：{exc}")
        return 3


def apply_set(pairs, config_path=None):
    """把 --set 的内容写进默认配置文件，返回 (路径, 合并后的内容)。"""
    target = config_path or DEFAULT_CONFIG_FILE
    data = parse_set_values(pairs)
    existing = {}
    if os.path.exists(target):
        existing = load_config_file(target)
    existing.update(data)
    write_config_file(target, existing)
    return target, existing


if __name__ == "__main__":
    opts = parse_args()

    if opts.list_cities:
        print_cities()
        sys.exit(0)

    if opts.sets:
        try:
            target, data = apply_set(opts.sets, opts.config_path)
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            print(f"配置错误：{exc}")
            sys.exit(2)
        print(f"已更新 {target}：")
        print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))
        sys.exit(0)

    if opts.show_config:
        try:
            show_config(resolve_config(options_to_overrides(opts)))
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            print(f"配置错误：{exc}")
            sys.exit(2)
        sys.exit(0)

    if opts.print_cron:
        try:
            overrides = options_to_overrides(opts)
            effective = resolve_config(overrides)
            cli_only = resolve_config(overrides, load_files=False)
            print_cron(effective, opts.cron_time, cli_cfg=cli_only)
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            print(f"配置错误：{exc}")
            sys.exit(2)
        sys.exit(0)

    sys.exit(main(force=opts.force, overrides=options_to_overrides(opts)))
