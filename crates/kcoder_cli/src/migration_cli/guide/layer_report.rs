//! Only Native's safe field-origin DTOs are printed; source values and private bindings never are.
use super::*;
use kcoder_migration::discovery::ConfigurationBinding;
use serde_json::{Value, json};

pub(super) fn show(guide: &Guide<'_>, binding: &ConfigurationBinding, saved: bool) -> Result<()> {
    let value = if binding.source_scope() == "codex-project-layers" {
        let report = if saved {
            binding.codex_layer_snapshot_report()?
        } else {
            binding.verify_codex_layer_authority(&guide.context.profile)?;
            binding.codex_layer_report()?
        };
        report.map(|report|json!({"fields":report.fields,"layersPresent":report.present,"profileSelected":report.profile_selected,"unobserved":report.unobserved}))
    } else {
        let report = if saved {
            binding.layer_snapshot_report()?
        } else {
            binding.layer_report()?
        };
        report.map(|report|json!({"fields":report.fields,"layers":report.layers,"adapterRevision":report.adapter_revision,"unobserved":report.unobserved}))
    };
    let Some(value) = value else {
        return guide.io.notice(
            "migration_layers_report_unavailable",
            "此原记录没有可用的封存层次报告；不会重新读取当前来源补造。",
        );
    };
    let fields = value["fields"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_layer_report"))?;
    ensure!(fields.len() <= 1024, "migration_source_budget_exceeded");
    let mut page = 0;
    loop {
        let mut output = value.clone();
        output["fields"] = Value::Array(fields.iter().skip(page * 10).take(10).cloned().collect());
        output["pageIndex"] = json!(page);
        output["totalFields"] = json!(fields.len());
        guide.io.state("configuration_layers", &output)?;
        match guide.io.ask("configuration_layers_page", "静态选定文件快照；不是来源程序运行时最终配置。next/prev 查看每页最多10项来源；back 返回。", json!({"page":page,"hasNextPage":(page+1)*10<fields.len()}), Some("back"))?.as_str() {
            "next" if (page+1)*10<fields.len() => page+=1,
            "prev" if page>0 => page-=1,
            "back" => return Ok(()),
            _ => guide.io.notice("migration_guide_invalid_selection", "请选择有效页或 back。")?,
        }
    }
}

pub(super) fn saved(guide: &Guide<'_>, job: &MigrationJob) -> Result<()> {
    let batch = job
        .batch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
    let mut choices: Vec<(String, String, &ConfigurationBinding)> = Vec::new();
    for item in &job.inventory.items {
        if let kcoder_migration::batch::BatchSource::Configuration(binding) =
            batch.source_for(&item.preview.id)?
            && binding.has_configuration_layers()
            && !choices.iter().any(|(_, _, old)| *old == binding)
        {
            choices.push((
                item.preview.id.clone(),
                item.preview.source_name.clone(),
                binding,
            ));
        }
    }
    if choices.is_empty() {
        return guide.io.notice(
            "migration_layers_report_unavailable",
            "此作业没有已选择的多层设置来源。",
        );
    }
    let mut page = 0;
    loop {
        let rows=choices.iter().skip(page*10).take(10).enumerate().map(|(n,(_,name,binding))|json!({"number":n+1,"name":name,"scope":binding.source_scope()})).collect::<Vec<_>>();
        let answer = guide.io.ask(
            "saved_configuration_layers",
            "选择本页设置来源编号查看原封存报告；next/prev 分页，back 返回。查看不刷新来源。",
            json!({"page":page,"items":rows}),
            Some("back"),
        )?;
        match answer.as_str() {
            "next" if (page + 1) * 10 < choices.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            "back" => return Ok(()),
            _ => {
                if let Some(index) = answer
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=10).contains(n))
                    .map(|n| page * 10 + n - 1)
                    .filter(|n| *n < choices.len())
                {
                    show(guide, choices[index].2, true)?
                } else {
                    guide
                        .io
                        .notice("migration_guide_invalid_selection", "请选择当前页编号。")?
                }
            }
        }
    }
}
