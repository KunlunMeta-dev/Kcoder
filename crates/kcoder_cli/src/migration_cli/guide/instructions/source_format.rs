//! A partial original request must retain its chosen parser, never infer or upgrade it.
use super::*;
pub(super) fn choose(guide: &Guide<'_>, recovering: bool) -> Result<bool> {
    if !recovering {
        return Ok(true);
    }
    loop {
        match guide.io.ask("instruction_format","选择该原捕获请求使用的解释。legacy-v1 仅恢复旧解释，static-v2 是已确认的新静态子集；不匹配原意图会拒绝，不能借恢复升级旧来源。",json!([
            {"value":"legacy-v1","label":"旧 v1 静态文件快照（保持原解释）"},
            {"value":"static-v2","label":"新 v2 已确认静态子集（根内引用/注释规则）"}
        ]),None)?.as_str() {
            "legacy-v1"=>return Ok(false),"static-v2"=>return Ok(true),
            _=>guide.io.notice("migration_guide_invalid_selection","请选择原请求的格式；不会自动推断或重绑定。")?,
        }
    }
}
pub(super) fn confirm(guide: &Guide<'_>) -> Result<()> {
    ensure!(guide.io.yes("instruction_static_subset","是否明确采用已授权静态文件子集？Codex 按普通 Markdown；Claude 只展开根内安全静态引用并处理代码/注释。不观察 managed/env/CLI/plugin 选择；未知语义保留待处理。不会读授权外路径，不提升系统权限。")?,"migration_instruction_static_subset_confirmation_required");
    Ok(())
}
