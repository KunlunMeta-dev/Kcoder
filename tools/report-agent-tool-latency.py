#!/usr/bin/env python3
"""Render recorded CLI tool measurements without running agents or loading credentials."""
import argparse
from collections import defaultdict
import csv
import html
import json
from pathlib import Path
import re
import statistics


def load_run(directory):
    directory = Path(directory).resolve()
    result = json.loads((directory / "results.json").read_text())
    for agent in result["results"]:
        terminal = {}
        for line in (directory / f"{agent['agent']}.stdout.jsonl").read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") == "tool_result":
                terminal[event["id"]] = event
        for index, sample in enumerate(agent["samples"], 1):
            event = terminal.get(f"bench_{agent['agent']}_{index}")
            if event is not None:
                sample["valid"] = not event.get("is_error", False)
    result["directory"] = str(directory)
    return result


def median(samples):
    values = [s["ms"] for s in samples if s["valid"]]
    return round(statistics.median(values), 2) if values else None


def optimization_summary(spec):
    before = load_run(spec["before"])["results"][0]
    after = load_run(spec["after"])["results"][0]
    assert before["code"] == after["code"] == 0
    rows = []
    for case in sorted({s["category"] for s in before["samples"]}):
        left = median([s for s in before["samples"] if s["category"] == case and s["round"] > 0])
        right = median([s for s in after["samples"] if s["category"] == case and s["round"] > 0])
        if left is not None and right is not None:
            rows.append({"case": case, "before_ms": left, "after_ms": right,
                         "reduction_percent": round((left-right)/left*100, 1)})
    specials = []
    for kind, left_path, right_path in [
        ("repl", spec["before_repl"], spec["after_repl"]),
        ("orphan", spec["before_orphan"], spec["after_repl"]),
    ]:
        left_run = load_run(left_path)["results"][0]
        right_run = load_run(right_path)["results"][0]
        for case in sorted({s["category"] for s in left_run["samples"]}):
            if ("orphan" in case) != (kind == "orphan"):
                continue
            left = median([s for s in left_run["samples"] if s["category"] == case])
            right = median([s for s in right_run["samples"] if s["category"] == case])
            if left is not None and right is not None:
                specials.append({"case": case, "before_ms": left, "after_ms": right,
                                 "reduction_percent": round((left-right)/left*100,1)})
    trace = (Path(spec["after_trace"]) / "kcoder.strace").read_text()
    return {"common": rows, "repl": specials,
            "after_environ_opens": len(re.findall(r"openat\([^\n]+/proc/\d+/environ",trace)),
            "evidence": spec}


def main():
    parser = argparse.ArgumentParser()
    for name in ("comparison", "audit", "repl", "javascript", "javascript-kcoder", "trace", "out"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--optimization", help="JSON manifest of frozen before/after run directories")
    args = parser.parse_args()
    comparison = load_run(args.comparison)
    audit = load_run(args.audit)
    repl = load_run(args.repl)
    javascript = load_run(args.javascript)
    javascript_kcoder = load_run(args.javascript_kcoder)
    primary = {r["agent"]: r for r in comparison["results"]}
    common = []
    labels = {
        "shell_noop": "Shell 短命令", "shell_read": "Shell 读取 200 行", "shell_search": "Shell 搜索 256 个文件",
        "native_read": "原生读取 200 行", "native_search": "原生内容搜索", "native_write": "原生新建文本文件",
        "python": "Python 脚本（均经 Shell）", "javascript": "JavaScript（同一 Bun，KCoder 用 REPL）",
    }
    for category, label in labels.items():
        row = {"case": category, "label": label}
        for name, run in primary.items():
            source = run
            selected = category
            if category == "javascript":
                source = next(r for r in (javascript_kcoder if name == "kcoder" else javascript)["results"] if r["agent"] == name)
            if category == "python" and name == "kcoder":
                selected = "python_shell"
            if category.startswith("native_") and name == "codex":
                row[name] = None
            else:
                row[name] = median([s for s in source["samples"] if s["category"] == selected and s["round"] > 0])
        common.append(row)
    current = audit["results"][0]
    grouped = defaultdict(list)
    for sample in current["samples"]:
        grouped[sample["tool"]].append(sample)
    excluded = {entry["name"]: entry["reason"] for entry in current["blocked"]}
    inventory = []
    for name in current["toolNames"]:
        samples = grouped.get(name, [])
        good = [s for s in samples if s["valid"]]
        bad = [s for s in samples if not s["valid"]]
        inventory.append({"tool": name, "status": "measured" if good else "unavailable" if samples else "not_measured",
                          "samples": len(samples), "successful": len(good), "errors": len(bad),
                          "median_ms": median(samples), "min_ms": round(min(s["ms"] for s in good), 2) if good else None,
                          "max_ms": round(max(s["ms"] for s in good), 2) if good else None,
                          "reason": excluded.get(name) or (bad[0].get("output_preview", "") if bad else ""),
                          "scenario": samples[0].get("input") if samples else None})
    repl_groups = defaultdict(list)
    for sample in repl["results"][0]["samples"]:
        repl_groups[sample["category"]].append(sample)
    repl_rows = [{"case": key, "median_ms": median(values), "first_ms": round(values[0]["ms"], 2),
                  "samples": len(values), "errors": sum(not s["valid"] for s in values)} for key, values in sorted(repl_groups.items())]
    notes = [
        "测量本机已安装的真实 CLI；本地固定响应只负责发出工具调用，不执行工具，也不调用真实模型。模型生成和模型服务网络延迟不进入指标。",
        "指标是工具调用往返：固定响应发出后，直到下一条请求携带工具结果；包含 CLI 调度、权限与状态处理、实际执行和结果序列化。不是只测系统命令的 CPU 时间。",
        "共同用例使用 1 次预热和 5 次计时，表格列中位数。原生 Read 使用内容相同的不同文件，避免把缓存占位回复当成真实读取。",
        "Codex 当前配置通过 Shell 完成读取、搜索和写入，因此原生工具行留空；对应操作可查看 Shell 行。Python 行使用相同解释器且均经 Shell；JavaScript 对照统一为 Bun，其中 KCoder 使用 REPL，其余使用 Shell。",
        "KCoder 全量审计为每个当前挂载工具挑选代表性路径，不穷举同一工具的全部 action、文件格式或外部服务。源于其它平台、未挂载的 Wiki/插件/MCP 和需要交互宿主的工具不在这个 CLI 清单中。",
        "审计中 Workflow 记录启动返回时间，SendMessage 记录受理时间，TaskOutput 记录状态读取时间；这些指标不等于后台任务的完成时间。",
        "公网 WebFetch/WebSearch 的网络耗时单列，WebBrowser 本次命中了 WebFetch 的共享缓存。它们不能直接与本地文件工具比较。",
        "新配置、会话、任务、工作树均为独立测试资源；没有使用个人凭证或真实模型，没有修改用户会话、全局配置或启动持久定时任务。",
        "测量版本为已安装 KCoder 2.0.0；刚修改的两分钟前台默认值尚未重新安装，且不影响这些短调用。首次调用不是清空操作系统缓存后的冷盘测试。",
        "strace 只用于定位，跟踪值不混入速度排名。它只记录系统调用路径，不采集 /proc 环境变量内容。",
    ]
    if args.optimization:
        notes[8] = "优化对照使用修改前和修改后的同构建档 Release 二进制，保留各自独立路径；两分钟前台预算与短调用耗时分别验证。操作系统缓存没有人为清空。"
    trace_text = (Path(args.trace) / 'kcoder.strace').read_text()
    scan_count = len(re.findall(r'openat\([^\n]+/proc/\d+/environ', trace_text))
    direct_shell = median([s for s in comparison['baseline'] if s['category'] == 'shell_noop' and s['round'] > 0])
    short_shell = next(r['kcoder'] for r in common if r['case'] == 'shell_noop')
    web_search = median(grouped.get('WebSearch', []))
    web_fetch = median(grouped.get('WebFetch', []))
    web_browser = median(grouped.get('WebBrowser', []))
    findings = [
        {"priority": "P1", "title": "Bash 正常退出后的全机进程扫描", "evidence": f"两次极短 Shell 调用共发生 {scan_count} 次 /proc/<pid>/environ 打开；没有执行独立 owner/supervisor。无跟踪时短命令约 {short_shell} ms，直接 Bash 约 {direct_shell} ms。系统调用跟踪会放大时间，不用于计算扫描占比。", "source": "crates/kcoder_tools/src/bash/process_owner.rs:134,185", "action": "复用内核/owner 持有的进程树归属，评估把现有 owned stdio owner 接入常规入口，减少全机枚举；必须保留 setsid、双重 fork、取消和断连后的归属清理。不能直接删扫描。"},
        {"priority": "P1", "title": "REPL 只在脚本退出后整体交付输出", "evidence": "每次调用创建脚本和新解释器；wait_with_output 等到退出。500 ms 分段输出用例在约 529–576 ms 后返回，没有中途交付打印结果。", "source": "crates/kcoder_tools/src/repl.rs:89,221,230", "action": "为界面接入带边界的实时输出/进度，复用受控任务与输出采集；保留最终结果和取消清理语义。此次未复现简单脚本执行本身巨慢。"},
        {"priority": "P2", "title": "REPL 大输出先全量收集再截断", "evidence": "4 MiB 输出用例全部完成；Python 约 103 ms，JavaScript 约 72 ms。当前流程收集完整 stdout/stderr，再格式化并应用显示限制。", "source": "crates/kcoder_tools/src/repl.rs:230,253", "action": "把输出限制和日志落盘前移到读取过程中，减少大结果的内存和复制；本轮数字只证明 4 MiB 场景，不外推无限输出。"},
        {"priority": "P2", "title": "REPL 每次重新启动解释器", "evidence": "小脚本中 Python 约 62 ms、JavaScript/Bun 约 37 ms、Shell 约 23 ms；直接 Python 基线约 61 ms，解释器自身成本占较大比例。", "source": "crates/kcoder_tools/src/repl.rs:391", "action": "优先合并同一任务内的细碎代码操作、改善反馈；不要直接改成共享常驻解释器，因为当前每次调用的变量、进程和权限隔离会改变。"},
        {"priority": "P2", "title": "公网搜索耗时单独处理", "evidence": f"单个实际搜索 {web_search} ms；网页抓取 {web_fetch} ms。结果包含外网耗时，不能归因于本地调度；浏览器文本导航命中缓存后 {web_browser} ms。", "source": "crates/kcoder_tools/src/web_search/runtime.rs; crates/kcoder_tools/src/web_network.rs", "action": "继续拆分排队、连接、来源首个有效结果和后续来源补全时间；保留明确预算与缓存，不通过延长所有工具的超时掩盖等待。"},
        {"priority": "P3", "title": "普通文件、记忆和配置工具暂无明显热点", "evidence": "代表性路径多为 8–35 ms；本轮没有为这些工具增加缓存或跳过检查的依据。文本写入不代表真实 LSP、PDF/Office 解析等重路径。", "source": "crates/kcoder_tools/src/file.rs; crates/kcoder_tools/src/grep.rs; crates/kcoder_tools/src/lsp.rs", "action": "保留原有边界，后续根据具体慢输入定位格式解析或语言服务器，避免无依据重构。"},
    ]
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    summary = {"versions": {k: r["version"] for k, r in primary.items()}, "inventory_count": len(inventory),
               "measured_tools": sum(r["status"] == "measured" for r in inventory),
               "unavailable_tools": sum(r["status"] == "unavailable" for r in inventory),
               "not_measured_tools": sum(r["status"] == "not_measured" for r in inventory),
               "audit_calls": len(current["samples"]), "comparison": common, "tools": inventory,
               "repl": repl_rows, "notes": notes, "findings": findings,
               "evidence": {key: str(getattr(args, key.replace('-', '_'))) for key in ("comparison", "audit", "repl", "javascript", "javascript-kcoder", "trace")}}
    if args.optimization:
        summary["optimization"] = optimization_summary(json.loads(Path(args.optimization).read_text()))
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with (out / "tools.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["tool", "status", "samples", "successful", "errors", "median_ms", "min_ms", "max_ms", "reason"])
        writer.writeheader()
        writer.writerows({k: v for k, v in item.items() if k != "scenario"} for item in inventory)
    esc = lambda value: html.escape(str(value))
    number = lambda value: "—" if value is None else f"{value:.2f}"
    table = lambda headers, rows: '<table><thead><tr>' + ''.join(f'<th>{esc(x)}</th>' for x in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{esc(x)}</td>' for x in row) + '</tr>' for row in rows) + '</tbody></table>'
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本机 Agent 工具延迟</title><style>body{font:15px/1.7 system-ui,sans-serif;color:#192332;background:#f6f7f9;margin:0}main{max-width:1180px;margin:auto;padding:36px 24px}section{background:white;border:1px solid #e1e5ea;border-radius:12px;padding:22px;margin:18px 0}h1{font-size:28px}h2{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e5e7eb;padding:10px;vertical-align:top;overflow-wrap:anywhere}th{background:#f6f7f9}p{margin:10px 0}.muted{color:#5a6879}code{background:#f3f4f6;padding:2px 4px}details{margin:12px 0}summary{cursor:pointer;font-weight:600}</style><main><h1>本机 Agent 工具延迟</h1>']
    parts.append(f'<p class="muted">Linux · 固定本地响应驱动真实工具 · {esc(summary["versions"])}</p>')
    parts.append(f'<section><h2>覆盖范围</h2><p>当前挂载 {len(inventory)} 种工具；{summary["measured_tools"]} 种取得有效执行样本，{summary["unavailable_tools"]} 种缺少依赖，{summary["not_measured_tools"]} 种保留前提限制。全量审计发出 {len(current["samples"])} 次调用；REPL 专项 {len(repl["results"][0]["samples"])} 次。</p><p>结果是代表性路径的测量，未测项没有被算作通过。</p></section>')
    if "optimization" in summary:
        opt = summary["optimization"]
        display_rows = lambda values: [[r["case"],number(r["before_ms"]),number(r["after_ms"]),f'{r["reduction_percent"]:+.1f}%'] for r in values]
        parts.append('<section><h2>KCoder 优化前后 · 同构建档 / ms</h2><p>正百分数表示耗时下降；负数表示增加，不隐藏回归。模型速度不进入指标。</p>' +
                     table(["共同操作", "优化前", "优化后", "下降比例"], display_rows(opt["common"])) +
                     '<h3>REPL 与后代占管道场景</h3>' + table(["场景", "优化前", "优化后", "下降比例"],display_rows(opt["repl"])) +
                     f'<p>优化后两次短命令跟踪中，数字 PID 的 environ 打开次数：{opt["after_environ_opens"]}。跟踪计数验证执行路径，跟踪耗时不参与排名。</p></section>')
        parts.append('<section><h2>本轮实施</h2><p>Shell 通过私有 owner 管理归属进程树，以退出事件唤醒收尾，保留不支持内核能力时的原清理路径。REPL 使用有界采集和流式完整日志；短调用直接返回，较长调用继续同一执行并接入进度管理，不重启脚本，也不重置总期限。Windows PowerShell/REPL 普通命令通过暂停创建后纳入私有 Job，保持原沙箱权限和结构化错误。</p><p>最终 Windows 原生检查单独记录在证据目录中；运行工具测试没有改动个人安装与会话。</p></section>')
    comparison_title = '初始三种 Agent 对照（优化前参考）' if args.optimization else '同类工具对照 · 中位数 / ms'
    parts.append(f'<section><h2>{comparison_title}</h2>' + table(["操作", "Claude", "Codex", "KCoder"], [[r["label"],number(r.get("claude")),number(r.get("codex")),number(r.get("kcoder"))] for r in common]) + '</section>')
    heading = '初始定位依据与观察项' if args.optimization else '优化优先级'
    parts.append(f'<section><h2>{heading}</h2>' + ''.join(f'<h3>{esc(f["priority"])} · {esc(f["title"])}</h3><p>{esc(f["evidence"])}</p><p>{esc(f["action"])}</p><p class="muted">{esc(f["source"])}</p>' for f in findings) + '</section>')
    parts.append('<section><h2>REPL 专项</h2>' + table(["场景", "首轮 ms", "中位数 ms", "样本", "错误"], [[r["case"],number(r["first_ms"]),number(r["median_ms"]),r["samples"],r["errors"]] for r in repl_rows]) + '</section>')
    parts.append('<section><h2>全部挂载工具</h2>' + table(["工具", "状态", "有效/调用", "中位数 ms", "最小–最大 ms", "限制或场景"], [[r["tool"],r["status"],f'{r["successful"]}/{r["samples"]}',number(r["median_ms"]),f'{number(r["min_ms"])}–{number(r["max_ms"])}',r["reason"] or json.dumps(r["scenario"],ensure_ascii=False)] for r in inventory]) + '</section>')
    parts.append('<section><h2>测量口径与边界</h2>' + ''.join(f'<p>{esc(note)}</p>' for note in notes) + '<details><summary>原始证据目录</summary>' + ''.join(f'<p>{esc(k)}：{esc(v)}</p>' for k,v in summary["evidence"].items()) + '</details></section></main></html>')
    (out / "report.html").write_text(''.join(parts))
    print(json.dumps({"report": str(out / "report.html"), "measured": summary["measured_tools"], "unavailable": summary["unavailable_tools"], "not_measured": summary["not_measured_tools"], "comparison": common}, ensure_ascii=False))


if __name__ == "__main__":
    main()
