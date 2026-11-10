// Real Windows Electron migration using only run-owned source and target profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const LONGFORM_MARKDOWN = [
  '# 工作推进与交付说明',
  '这份示例用于检查长文的阅读体验：先给出进展，再列出下一步行动，最后提供验收依据。段落、标题和表格应保持清楚的层级。',
  '## 一、当前进展',
  '会话迁入后，可以查看原始对话，并从未完成的工作继续推进。原有材料保持来源关联，新的操作使用当前可用工具。',
  '### 已完成事项',
  '- 梳理任务目标与现有结果。\n- 核对来源材料和关键数据。\n  - 金额：逐项核算。\n  - 日期：回到原始材料确认。',
  '> 阅读提示：先看结论和行动项；需要核对细节时，再查看来源和过程记录。',
  '## 二、下一步安排',
  '| 工作内容 | 当前状态 | 交付内容 | 验收方式 |\n| --- | --- | --- | --- |\n| 补齐未完成事项 | 正在推进 | 可读取的文件 | 核对关键数据 |\n| 汇总材料 | 等待核对 | 来源与待确认项 | 回到材料逐项确认 |\n| 形成最终报告 | 计划执行 | 结论与后续行动 | 检查依据是否充分 |',
  '### 文件与执行记录',
  '生成文件后应检查内容，而不只根据执行提示判断是否成功。下方代码保持独立的等宽排版：',
  '```text\noutputs/阶段工作报告.md\noutputs/数据核对表.csv\n```',
  'READABILITY_FIXTURE_DONE',
].join('\n\n');

const digest = value => createHash('sha256').update(value).digest('hex');

function seedMigrationUi({ root, profile, workspace, historyCount = 1 }) {
  const ambient = path.join(root, 'migration-home');
  const claude = path.join(ambient, '.claude');
  const codex = path.join(ambient, '.codex');
  const marker = path.join(workspace, 'SOURCE_COMMAND_MUST_NOT_EXECUTE');
  const launch = Buffer.from(`[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'unexpected')`, 'utf16le').toString('base64');
  const command = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', launch] };
  const files = new Map();
  const write = (relative, value) => {
    const file = path.join(ambient, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    files.set(file, digest(fs.readFileSync(file)));
  };
  write('.claude/settings.json', JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1', ANTHROPIC_MODEL: 'owned-windows-claude',
    ANTHROPIC_API_KEY: 'SYNTHETIC_WINDOWS_MIGRATION_KEY',
  }, mcpServers: { 'owned-claude-mcp': command } }));
  write('.claude/CLAUDE.md', 'Keep original documents unchanged. OWNED_CLAUDE_INSTRUCTION.\n');
  write('.claude/skills/owned-claude-office/SKILL.md', '---\nname: owned-claude-office\ndescription: Read an owned office document\n---\nOWNED_CLAUDE_SKILL. Preserve source evidence.\n');
  write('.codex/config.toml', [
    "model = 'owned-windows-codex'", "model_provider = 'OwnedWindows'",
    '[model_providers.OwnedWindows]', "base_url = 'http://127.0.0.1:9/v1'", "wire_api = 'responses'",
    "[mcp_servers.'owned-codex-mcp']", "command = 'powershell.exe'",
    `args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', '${launch}']`, '',
  ].join('\n'));
  write('.codex/AGENTS.md', 'Keep original documents unchanged. OWNED_CODEX_INSTRUCTION.\n');
  write('.agents/skills/owned-codex-office/SKILL.md', '---\nname: owned-codex-office\ndescription: Read an owned office document\n---\nOWNED_CODEX_SKILL. Preserve source evidence.\n');
  for (const vendor of ['claude', 'codex']) for (let index = 0; index < historyCount; index++) {
    const id = randomUUID();
    const text = `OWNED_WINDOWS_${vendor.toUpperCase()}_HISTORY`;
    const records = vendor === 'claude' ? [
      { type: 'user', uuid: 'u', sessionId: id, version: '2.1.301', message: { role: 'user', content: text } },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: id, version: '2.1.301', message: { role: 'assistant', content: 'Owned historical response.' } },
    ] : [
      { type: 'session_meta', payload: { id, cli_version: '0.163.0' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Owned historical response.' }] } },
    ];
    const relative = vendor === 'claude' ? `.claude/projects/owned-windows/${id}.jsonl`
      : `.codex/sessions/2026/10/22/rollout-2026-10-22T00-00-00-${id}.jsonl`;
    write(relative, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  for (const directory of [ambient, ...['Downloads','Desktop','Documents','Pictures','Music','Videos','AppData/Roaming','AppData/Local'].map(leaf => path.join(ambient,leaf))]) fs.mkdirSync(directory, { recursive: true });
  const settingsFile = path.join(profile, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.credential_store = 'file';
  settings.mcp_servers = [];
  settings.mcp_disabled_servers = [];
  settings.providers.fixture.authentication = { mode: 'none' };
  settings.providers.fixture.discover_models = false;
  settings.providers.fixture.no_proxy = true;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  return { ambient, claude, codex, files, marker, original: settings,
    environment: { USERPROFILE: ambient, HOME: ambient, APPDATA: path.join(ambient, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(ambient, 'AppData/Local'), CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}

async function runMigrationUi({ evaluate, until, navigate, click, screenshot, profile, fixture, setStage, binary, quickOnly = false, insertText, resize }) {
  const modal = '[data-testid="migration-dialog"]';
  const text = value => JSON.stringify(value);
  const hasText = async value => evaluate(`Boolean(document.querySelector(${text(modal)})?.innerText.includes(${text(value)}))`);
  const button = async (name, scope = modal) => until(() => evaluate(`(() => {
    const e=[...document.querySelectorAll(${text(scope + ' button')})].find(e=>(e.textContent.trim()===${text(name)}||e.getAttribute('aria-label')===${text(name)})&&e.getClientRects().length);
    if(!e||e.disabled)return false;e.scrollIntoView({block:'center'});e.click();return true;
  })()`));
  const fill = async (label, value) => {
    const changed = await evaluate(`(() => {
      const e=[...document.querySelectorAll(${text(modal + ' input')})].find(e=>e.getAttribute('aria-label')===${text(label)}&&e.getClientRects().length);
      if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${text(value)});
      e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;
    })()`);
    assert.equal(changed, true, 'visible migration field: ' + label);
  };
  const checkSources = () => {
    for (const [file, hash] of fixture.files) assert.equal(digest(fs.readFileSync(file)), hash, 'source bytes must remain unchanged');
    assert.equal(fs.existsSync(fixture.marker), false, 'source MCP command must not execute');
  };
  const settings = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  const results = [];
  setStage('migration-open-settings');
  await click('settings-button');await click('settings-menu-button');
  await until(()=>evaluate(`Boolean(document.querySelector('[data-testid="general-external-content-import-button"]'))`),30000);
  if (quickOnly) {
    setStage('quick-migration-open');
    await click('general-external-content-import-button');
    await until(() => evaluate(`Boolean(document.querySelector('[data-testid="migration-quick-start"]'))`));
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="migration-mode-plugins"]'))`), false);
    await screenshot('windows-quick-migration-ready.png');
    setStage('quick-migration-click-start');await click('migration-quick-start');
    setStage('quick-migration-discover');
    await until(async () => {
      const snapshot=await evaluate(`(()=>({rows:document.querySelectorAll('[data-testid="migration-quick-row"]').length,progress:document.querySelector('[data-testid="migration-quick-progress"]')?.innerText,error:[...document.querySelectorAll('[data-testid="migration-quick-history"] [role="alert"]')].map(e=>e.innerText)}))()`);
      setStage('quick-migration-discover:'+JSON.stringify(snapshot));return snapshot.rows===6;
    },30000);
    setStage('quick-migration-pause');await click('migration-quick-pause');
    await until(() => evaluate(`!document.querySelector('[data-testid="migration-quick-start"]')?.disabled`), 30000);
    setStage('quick-migration-continue');await click('migration-quick-start');
    const first = await until(async () => {
      const status=await evaluate(`(()=>({busy:document.querySelector('[data-testid="migration-quick-start"]')?.disabled,progress:document.querySelector('[data-testid="migration-quick-progress"]')?.innerText,rows:[...document.querySelectorAll('[data-testid="migration-quick-row"]')].map(e=>({status:e.dataset.migrationStatus,error:e.dataset.errorCode}))}))()`);
      setStage('quick-migration-continue:'+JSON.stringify(status));return !status.busy ? status.progress : false;
    },120000);
    assert.ok(first.includes('已迁入 6'),'Expected all conversations, actual progress: '+first);
    assert.ok(first.includes('需处理 0'), 'Every owned conversation must be ready');
    const nativeSessions = () => {
      const ids=[]; const parent=path.join(profile,'projects');
      if(fs.existsSync(parent))for(const folder of fs.readdirSync(parent,{withFileTypes:true}))if(folder.isDirectory())
        for(const file of fs.readdirSync(path.join(parent,folder.name)))if(/^[a-zA-Z0-9]{5}\.jsonl$/.test(file))ids.push(folder.name+'/'+file);
      return ids.sort();
    };
    const before=nativeSessions();assert.equal(before.length,6,'Native must publish every owned conversation');
    await screenshot('windows-quick-migration-complete.png');
    assert.equal(await evaluate(`document.querySelectorAll('[data-testid="migration-quick-row"]').length`),6);
    await resize(860,900);
    assert.equal(await evaluate(`(()=>{const e=document.querySelector('[data-testid="migration-dialog"]');return e.scrollWidth<=e.clientWidth+1})()`),true);
    await screenshot('windows-quick-migration-narrow.png');
    await button('关闭');await click('settings-nav-appearance');await click('appearance-mode-dark');await click('settings-nav-general');
    await click('general-external-content-import-button');await click('migration-quick-start');
    await until(() => evaluate(`!document.querySelector('[data-testid="migration-quick-start"]')?.disabled && document.querySelector('[data-testid="migration-quick-progress"]')?.innerText.includes('已迁入 6')`), 120000);
    assert.deepEqual(nativeSessions(),before,'Reopening and repeating the import must not create duplicate sessions');
    assert.equal(await evaluate(`document.documentElement.dataset.theme`),'dark');
    await screenshot('windows-quick-migration-dark.png');checkSources();
    return {passed:true,actualWindowsElectron:true,quickHistory:{sources:2,conversations:6,pages:[6],pausedAndContinued:true,reopenedWithoutDuplicates:true,lightDarkAndNarrow:true,sourceBytesUnchanged:true},nativeCliSha256:digest(fs.readFileSync(binary)),paidProviderRequests:0,historicalToolsExecuted:false};
  }
  for (const vendor of ['claude', 'codex']) {
    setStage('migration-' + vendor + '-discovery');
    await click('general-external-content-import-button');
    await until(() => evaluate(`Boolean(document.querySelector(${text(modal)}))`));
    await click('migration-advanced-toggle');await button('批量迁移');
    if (vendor === 'codex') await button('Codex');
    await button('查找可迁移内容');
    await until(() => evaluate(`document.querySelectorAll(${text(modal + ' [data-testid^="migration-source-row-"]')}).length>0`));
    await button('预览所选来源');
    await until(() => hasText('选择迁移内容'));
    const count = await evaluate(`document.querySelectorAll(${text(modal + ' [data-testid="migration-content-item"]')}).length`);
    assert.ok(count >= 3, 'provider and compatible office assets must be discovered');
    const targetName = vendor === 'claude' ? 'OwnedWindowsClaude' : 'OwnedWindowsCodex';
    let configured = false;
    for (let index = 0; index < count; index++) {
      const scope = modal + ` [data-testid="migration-content-item"]:nth-child(${index + 1})`;
      const opened = await evaluate(`(() => {
        const row=[...document.querySelectorAll(${text(modal + ' [data-testid="migration-content-item"]')})][${index}];
        const e=[...row.querySelectorAll('button')].find(e=>e.textContent.trim()==='配置');
        if(!e||e.disabled)return false;e.click();return true;
      })()`);
      if (!opened) continue;
      const provider = await until(async () => {
        const labels = await evaluate(`(() => {const r=[...document.querySelectorAll(${text(modal + ' [data-testid="migration-content-item"]')})][${index}];return [...r.querySelectorAll('input[aria-label]')].map(e=>e.getAttribute('aria-label'))})()`);
        return labels.length ? labels : null;
      });
      if (!provider.includes('上下文额度')) { await button('关闭', scope); continue; }
      await fill('保存后的连接名称', targetName);
      await fill('上下文额度', '128000'); await fill('输出预留额度', '8192'); await fill('最大输出额度', '8192');
      await button('保存选项并选择', scope); configured = true; break;
    }
    assert.ok(configured, 'a provider can be configured through the migration UI');
    setStage('migration-' + vendor + '-preview');
    await button('确认所选内容');
    await until(() => hasText('确认批量计划'));
    assert.deepEqual(settings(), fixture.original, 'preview must not publish'); checkSources();
    await screenshot('windows-migration-' + vendor + '-preview.png');
    await button('开始批量迁移');
    await until(() => hasText('迁移结果'), 30000);
    await until(() => Boolean(settings().providers[targetName]), 30000);
    assert.equal(settings().active_provider, fixture.original.active_provider);
    assert.equal(settings().providers[targetName].default_model, 'owned-windows-' + vendor);
    assert.ok(!JSON.stringify(settings()).includes('SYNTHETIC_WINDOWS_MIGRATION_KEY'));
    checkSources();
    await screenshot('windows-migration-' + vendor + '-saved.png');
    const mcp = (settings().mcp_servers || []).find(item => item.name.includes('owned-' + vendor + '-mcp'));
    assert.ok(mcp, 'MCP definition must be saved');
    assert.ok((settings().mcp_disabled_servers || []).includes(mcp.name), 'imported MCP remains disabled');
    const resultText = await evaluate(`document.querySelector(${text(modal)})?.innerText || ''`);
    const savedCount = resultText.match(/已迁入 (\d+) \/ (\d+) 项/)?.slice(1).map(Number);
    assert.ok(savedCount && savedCount[0] === savedCount[1] && savedCount[0] >= 3, 'all selected compatible assets must have receipts');
    setStage('migration-' + vendor + '-undo');
    await button('撤销本次导入');
    await until(() => hasText('已撤销'), 30000);
    await until(() => !settings().providers[targetName], 30000);
    assert.deepEqual(settings(), fixture.original, 'owned undo restores the original target settings'); checkSources();
    results.push({ source: vendor, selectedItems: savedCount[1], importedItems: savedCount[0], previewDidNotPublish: true,
      activeProviderPreserved: true, mcpInitiallyDisabled: true, sourceCommandsExecuted: false,
      privateValuesAbsentFromSettings: true, sourceBytesUnchanged: true, undoRestoredSettings: true });
    await button('关闭');
    await until(() => evaluate(`!document.querySelector(${text(modal)})`));
  }
  setStage('longform-conversation');
  await click('settings-back-button');
  await until(()=>evaluate(`Boolean(document.querySelector('[data-testid="chat-message-input"]'))`));
  await evaluate(`document.querySelector('[data-testid="chat-message-input"]').focus();true`);
  await insertText('请展示长文排版示例。');await click('send-message-button');
  await until(()=>evaluate(`document.querySelector('.assistant-markdown')?.innerText.includes('READABILITY_FIXTURE_DONE')`),30000);
  const readability = await evaluate(`(()=>{
    const root=document.querySelector('.assistant-markdown[data-conversation-reading="true"]');
    const size=tag=>parseFloat(getComputedStyle(root.querySelector(tag)).fontSize);
    const table=root.querySelector('[data-reading-table]');
    return {headingSizes:['h1','h2','h3'].map(size),bodySize:size('p'),
      sectionInset:parseFloat(getComputedStyle(root.querySelector('h2')).paddingBlockStart),
      topAlignedCells:getComputedStyle(root.querySelector('td')).verticalAlign==='top',
      tableContained:table.scrollWidth<=table.clientWidth+1,
      proseContained:root.scrollWidth<=root.clientWidth+1};
  })()`);
  assert.ok(readability.headingSizes[0]>readability.headingSizes[1]&&readability.headingSizes[1]>readability.headingSizes[2]&&readability.headingSizes[2]>readability.bodySize);
  assert.ok(readability.sectionInset>0);assert.equal(readability.topAlignedCells,true);assert.equal(readability.proseContained,true);
  await evaluate(`document.querySelector('.assistant-markdown h1').scrollIntoView({block:'start'});true`);
  await screenshot('windows-longform-readable.png');
  await click('settings-button');await click('settings-menu-button');await click('settings-nav-appearance');
  await click('appearance-mode-dark');await click('settings-back-button');
  await until(()=>evaluate(`document.documentElement.dataset.theme==='dark'`));
  await evaluate(`document.querySelector('.assistant-markdown h1').scrollIntoView({block:'start'});true`);
  await screenshot('windows-longform-dark.png');
  await resize(860,900);
  await evaluate(`document.querySelector('.assistant-markdown [data-reading-table]').scrollIntoView({block:'center'});true`);
  const narrow=await evaluate(`(()=>{const r=document.querySelector('.assistant-markdown');const t=r.querySelector('[data-reading-table]');return{proseContained:r.scrollWidth<=r.clientWidth+1,tableScrollOwner:getComputedStyle(t).overflowX==='auto'}})()`);
  assert.equal(narrow.proseContained,true);assert.equal(narrow.tableScrollOwner,true);
  readability.darkThemeVerified=true;readability.narrowViewportVerified=true;
  await screenshot('windows-longform-narrow.png');
  return { passed: true, actualWindowsElectron: true, migration: results, readability,
    nativeCliSha256: digest(fs.readFileSync(binary)),
    sourceKind: 'owned synthetic Windows user directories', paidProviderRequests: 0,
    actualPersonalSourceImport: 'not_claimed_by_this_fixture', historicalToolsExecuted: false };
}

module.exports = { seedMigrationUi, runMigrationUi, LONGFORM_MARKDOWN };
