use super::*;
use std::collections::BTreeMap;

impl Guide {
    pub(in crate::migration_cli::transfer::guide) async fn map_instructions(
        &self,
        entry: &str,
    ) -> Result<MigrationSourceInstructionMapping> {
        ensure!(self.io.yes("transfer_instruction_workspace","确认将所选指令明确映射到当前目标工作区？原生将验证真实目录身份与当前信任；不按来源路径推断目标、不回退用户层。")?,"migration_instruction_target_scope_required");
        let mut client = self.instruction_client().await?;
        let result = self.map_instruction_items(&mut client, entry).await;
        let closed = client.close().await;
        if closed.is_err() {
            self.io.notice(
                "migration_remote_connection_close_unknown",
                "本预览连接释放未确认，原传输回执和映射身份仍保留。",
            )?;
        }
        result
    }
    async fn map_instruction_items(
        &self,
        client: &mut runtime::Client,
        entry: &str,
    ) -> Result<MigrationSourceInstructionMapping> {
        let target = MigrationInstructionReadTarget::Received {
            request_id: self.draft.request_id.clone(),
            manifest_sha256: self
                .draft
                .manifest_sha256
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_transfer_receipt_required"))?,
            entry_id: entry.into(),
        };
        let mut selected = BTreeMap::new();
        let mut incomplete = BTreeMap::new();
        let mut page = 0;
        loop {
            let result = self.instruction_page(client, &target, page).await?;
            let rows=result.items.iter().enumerate().map(|(at,item)|json!({"number":at+1,"item":item,"targetRelativeScope":selected.get(&item.item_id)})).collect::<Vec<_>>();
            let answer=self.io.ask("transfer_instruction_mapping","逐项指令映射：toggle N选择/移除，original N/compiled N预览，next/prev，done确认，quit放弃。本次选择只保存待停用资产。",json!({"page":page,"items":rows,"selected":selected.len(),"hasNextPage":result.next_page.is_some()}),None)?;
            let mut words = answer.split_whitespace();
            match words.next().unwrap_or("") {
                "quit" => anyhow::bail!("migration_transfer_guide_stopped"),
                "next" if result.next_page.is_some() => page = result.next_page.unwrap(),
                "prev" if page > 0 => page -= 1,
                "done" if !selected.is_empty() => {
                    let archive = incomplete.values().any(|value| *value);
                    if archive {
                        ensure!(self.io.yes("transfer_instruction_archive","所选内容含未知/不完整链。是否仅保留原件为停用待处理资产？此确认不让未知链启用或获得来源权限。")?,"migration_instruction_incomplete_chain_confirmation_required");
                    }
                    ensure!(self.io.yes("transfer_instruction_mapping_confirm","确认这些逐项目标目录和静态子集？准备接纳后同adoptionId不可更换映射，迁入默认停用。")?,"migration_transfer_confirmation_required");
                    return Ok(MigrationSourceInstructionMapping {
                        entry_id: entry.into(),
                        items: selected
                            .into_iter()
                            .map(|(item_id, target_relative_scope)| {
                                MigrationInstructionScopeChoice {
                                    item_id,
                                    target_relative_scope,
                                }
                            })
                            .collect(),
                        archive_incomplete_chain: archive,
                    });
                }
                verb @ ("toggle" | "original" | "compiled") => {
                    let item = words
                        .next()
                        .and_then(|n| n.parse::<usize>().ok())
                        .filter(|n| (1..=10).contains(n))
                        .and_then(|n| result.items.get(n - 1))
                        .ok_or_else(|| anyhow::anyhow!("migration_transfer_invalid_selection"))?;
                    if verb != "toggle" {
                        self.target_body(
                            client,
                            &target,
                            &item.item_id,
                            if verb == "compiled" {
                                InstructionRepresentation::Compiled
                            } else {
                                InstructionRepresentation::Original
                            },
                        )
                        .await?;
                        continue;
                    }
                    if selected.remove(&item.item_id).is_some() {
                        incomplete.remove(&item.item_id);
                        continue;
                    }
                    ensure!(
                        selected.len() < INSTRUCTION_MAX_FILES,
                        "migration_transfer_selection_budget_exceeded"
                    );
                    let scope=self.io.text("transfer_instruction_scope","输入目标工作区内已存在目录的相对路径；.表示工作区根。不创建新目录，不接受绝对路径或..。",None)?;
                    let choice:MigrationInstructionScopeChoice=serde_json::from_value(json!({"itemId":item.item_id,"targetRelativeScope":if scope=="." {""}else{scope.as_str()}})).map_err(|_|anyhow::anyhow!("migration_instruction_target_scope_required"))?;
                    selected.insert(item.item_id.clone(), choice.target_relative_scope);
                    incomplete.insert(
                        item.item_id.clone(),
                        !item.complete_authorized_static_chain
                            || item.disposition == InstructionSourceDisposition::RequiresReview,
                    );
                }
                _ => self.io.notice(
                    "migration_transfer_invalid_selection",
                    "请明确选择当前页指令及目标目录。",
                )?,
            }
        }
    }
}
