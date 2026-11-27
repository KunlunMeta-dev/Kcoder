# 更新与 `_notice`

lark-cli 命令执行后，如果检测到新版本，JSON 输出中会包含 `_notice.update` 字段（含 `message`、`command` 等）。

除非用户正在询问更新、版本或 notice，否则不要把 `_notice` 原样复制为当前任务的主要答案，也不要为了 notice 中断当前任务去反复查 help。

需要稳定 JSON 给脚本或机器读取时，可以在命令前设置：

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 <lark-cli command>
```

当你在输出中看到 `_notice.update` 时，先完成用户当前请求；如仍相关，再简短告知可运行：

```bash
lark-cli update
```

**重要**：始终使用 `lark-cli update` 更新，它会同时更新 CLI 和 AI Skills。

> KCoder 说明（非上游内容）：本机 KCoder Studio 目标上的 `lark-cli` 和这些 skill 随 Studio 一起发布和升级。看到 `_notice.update` 或 `_notice.skills` 时，告知用户升级 KCoder Studio 即可；不要为这份随附 CLI 运行 `lark-cli update`、`npm install -g` 或 `npx skills add`。用户自行安装的 `lark-cli` 仍按上文更新。

另外两类 notice：
- `_notice.skills`：本地 Skills 与当前 CLI 不同步。
- `_notice.deprecated_command`：本次使用了兼容保留的旧命令；后续调用改用 `replacement`。如果同时提供 `action: "lark-cli update"`，同样建议升级。
