//! Opening a record reads its existing journal; it never creates a replacement operation.
use super::*;
use serde_json::json;

pub(super) enum Entry {
    New {
        history: bool,
        plugins: bool,
        memory: bool,
        definitions: bool,
    },
    ReadyPlugin(Box<kcoder_migration::batch::BatchSource>),
    Existing(String),
    Instructions,
    Projects,
    Creation,
    Quit,
}
pub(super) fn choose(guide: &Guide<'_>) -> Result<Entry> {
    loop {
        match guide.io.ask("entry","开始新迁移，或从原记录继续；历史专用阅读与接续仍可使用 /migration。",json!([
            {"value":"projects","label":"迁入项目清单并明确关联Native目标目录（不复制工作树）"},
            {"value":"instructions","label":"明确授权指令目录并映射到当前工作区"},{"value":"creation","label":"按原请求核对或恢复尚未发布的捕获"},
            {"value":"new","label":"迁移配置和兼容资产"},{"value":"new-with-history","label":"迁移配置、兼容资产与明确选择的历史"},{"value":"new-with-plugins","label":"审查并迁入明确选择的插件"},{"value":"new-all","label":"明确选择配置、资产、历史、插件与记忆"},{"value":"new-with-definitions","label":"保存待处理Agent/Hook定义（不执行）"},{"value":"new-with-memory","label":"明确选择未验证的来源记忆笔记"},{"value":"memory-records","label":"管理已迁入的未验证笔记"},{"value":"records","label":"分页查看已有批次"},{"value":"plugin-records","label":"回读和恢复插件复制记录"},{"value":"quit","label":"退出"}
        ]),None)?.as_str() {
            "new-with-definitions"=>return Ok(Entry::New {history:false,plugins:false,memory:false,definitions:true}),
            "projects"=>return Ok(Entry::Projects),
            "instructions"=>return Ok(Entry::Instructions),
            "creation"=>return Ok(Entry::Creation),
            "new"=>return Ok(Entry::New { history: false, plugins:false, memory:false, definitions:false }),
            "new-with-history"=>return Ok(Entry::New { history: true, plugins:false, memory:false, definitions:false }),
            "new-with-plugins"=>return Ok(Entry::New { history: false, plugins:true, memory:false, definitions:false }),
            "new-with-memory"=>return Ok(Entry::New { history:false, plugins:false, memory:true, definitions:false }),
            "new-all"=>return Ok(Entry::New { history: true, plugins:true, memory:true, definitions:false }),"quit"=>return Ok(Entry::Quit),
            "memory-records"=>super::memory::records(guide)?,
            "plugin-records"=>match plugin_sources::records(guide)? {
                Some(plugin_sources::RecordSelection::Ready(source))=>return Ok(Entry::ReadyPlugin(source)),
                Some(plugin_sources::RecordSelection::Batch(id))=>return Ok(Entry::Existing(id)),None=>{},
            },
            "records"=>if let Some(id)=records(guide)? {return Ok(Entry::Existing(id));},
            _=>guide.io.notice("migration_guide_invalid_selection","请选择列表中的来源/记录入口；未修改目标。")?,
        }
    }
}
fn records(guide: &Guide<'_>) -> Result<Option<String>> {
    let context = guide.fresh()?;
    let store = match MigrationStore::open_existing(&context.profile) {
        Ok(store) => store,
        Err(error)
            if error.chain().any(|e| {
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            guide
                .io
                .notice("migration_guide_no_records", "当前目标尚无迁移记录。")?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut cursor = None;
    loop {
        let (records, next) = store.records(cursor.as_deref())?;
        let rows=records.iter().enumerate().map(|(index,record)|json!({"number":index+1,"jobId":record.job_id,"source":record.source,"status":record.status,"isBatch":record.batch,"selectedItems":record.selected_items,"committedItems":record.committed_items,"hasUnconfirmedOutcomes":record.has_unconfirmed_outcomes})).collect::<Vec<_>>();
        let answer = guide.io.ask(
            "records",
            "每页最多10条记录。输入编号打开原记录，next 下一页，back 返回；读取不会重试任何变更。",
            json!({"items":rows,"hasNextPage":next.is_some()}),
            None,
        )?;
        match answer.as_str() {
            "back" => return Ok(None),
            "next" if next.is_some() => cursor = next,
            _ => {
                if let Some(record) = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| records.get(n))
                {
                    return Ok(Some(record.job_id.clone()));
                } else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "请选择本页编号或有效翻页操作。",
                    )?;
                }
            }
        }
    }
}
