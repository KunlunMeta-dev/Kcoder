import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from '../../harness/run-context.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const region = (text, start, end) => {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'fixed real source boundaries');
  return text.slice(first, last);
};

export async function prepareWikiCostCorpus(context) {
  const download = async (url, limit) => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, 'public corpus download');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.length <= limit);
    return bytes;
  };
  const paperUrl = 'https://arxiv.org/pdf/1706.03762';
  const pdf = await download(paperUrl, 4000000);
  const pdfPath = context.pathInState('attention.pdf'), textPath = context.pathInState('attention.txt');
  await writeFile(pdfPath, pdf, { mode: 0o400 });
  const process = context.spawnOwned('public-pdf-extraction', 'pdftotext', ['-f', '1', '-l', '2', pdfPath, textPath], { env: context.isolatedEnvironment() });
  await new Promise((done, fail) => { process.once('error', fail); process.once('exit', code => code === 0 ? done() : fail(Error('public PDF extraction failed'))); });
  const extracted = await readFile(textPath, 'utf8');
  const abstract = region(extracted, 'Abstract', '∗');
  const introduction = region(extracted, '1\n\nIntroduction', '3\n\nModel Architecture');
  // Two exact contiguous text regions; authors' contact details and footnotes are excluded.
  const paper = abstract + '\n' + introduction;
  const chinesePath = 'docs/kcoder-wiki-validation-2026-09-29.md';
  const chineseOriginal = await readFile(resolve(repoRoot, chinesePath), 'utf8');
  const chinese = chineseOriginal.slice(chineseOriginal.indexOf('## 一次性检索性能测试'));
  const tablePath = 'docs/wiki-format-support-audit-2026-10-02.md';
  const tableOriginal = await readFile(resolve(repoRoot, tablePath), 'utf8');
  const table = region(tableOriginal, '| Format | Observed behavior |', '## Confirmed gaps and boundaries');
  const htmlUrl = 'https://www.iana.org/help/example-domains';
  const html = await download(htmlUrl, 40000);
  const corpus = [
    { id: 'paper', format: 'PDF extracted text', origin: paperUrl, original: pdf, input: Buffer.from(paper),
      selection: 'pdftotext physical pages 1–2; exact abstract and introduction/background regions, no author contacts',
      facts: [['attention-only architecture', ['Transformer', '注意力|attention']], ['German BLEU 28.4', ['28\\.4', '德|German']], ['French BLEU 41.8', ['41\\.8', '法|French']], ['3.5 days eight GPUs', ['3\\.5', '8|八', 'GPU']]],
      focus: 'Transformer架构、英德与英法BLEU、训练时间和GPU数量，保留实验限定范围。' },
    { id: 'chinese', format: 'Chinese long-form technical record', origin: chinesePath, original: Buffer.from(chineseOriginal), input: Buffer.from(chinese),
      selection: 'complete long-form record from performance section through navigation, excluding the earlier 795-byte staged sample',
      facts: [['updates preserve source identity and old revisions', ['source ID|来源.*ID', 'revision|修订']], ['removal revokes leases and pauses jobs', ['移除|删除', '租约', '暂停']], ['missing usage is unknown rather than free', ['usage_reported_calls|未知|未报告', '免费|不等于|不代表']], ['all-page CAS before transaction commit', ['CAS', '整批|批次|全部', '事务']]],
      focus: '来源更新/移除与恢复、未知usage及持久预算、Markdown批次CAS和幂等，保留明确未完成验收边界。' },
    { id: 'table', format: 'Real audit Markdown table', origin: tablePath, original: Buffer.from(tableOriginal), input: Buffer.from(table),
      selection: 'complete seven-row historical 0.3.1 format results table',
      facts: [['TXT GBK rejected', ['GBK', '拒绝|不支持|reject']], ['PDF scanned and protected rejected without OCR', ['扫描|scanned', '密码|保护|password', 'OCR']], ['XLSX uncached formula and notice retained', ['公式|formula', '缓存|cache']], ['image real recognition unmeasured', ['图像|图片|image', '未|not', '识别|recognition']]],
      focus: '历史0.3.1格式表：文本编码、扫描/加密PDF和OCR边界、Excel无缓存公式、图像协议验证与真实识别未测。' },
    { id: 'html', format: 'Real public HTML', origin: htmlUrl, original: html, input: html,
      selection: 'complete public IANA page, production offline HTML parser via attachment import',
      facts: [['example domains are for documentation', ['example\\.com', 'example\\.org', '文档|documentation']], ['no prior coordination needed', ['无需|不需|without', '协调|coordination']], ['no registration or transfer', ['注册|registration', '转让|转移|transfer', '不|not']], ['HTTP service best effort and not production', ['尽力|best.effort', '生产|production']]],
      focus: '示例域名用途、无需事先协调、不可注册或转让、HTTP尽力服务不用于生产依赖。' },
  ];
  const frozen = {
    paper: ['bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697', 'a8670dc73d51bd62298c0634130f58bc63e8b3802cbf9bfd0a5a559c93558e47'],
    chinese: ['540d155c65c966f1c5495d4a667cbd12d73d143e0119dfcb05a8734772a7e803', '1b8a06c06312349513f6467c96876ec93801a6c89db0cdc569718effa2687776'],
    table: ['339ac92c23181e16475ebb640083f80eb9feb9c518548eb73dff2ef5865ed544', '079dee1b792c87bcc1d32a4f2414a8bfd4f4046676f5572de37d2d3236c9efaf'],
    html: ['9adb74216b75a090d7b8764453146efc9480942bedc0616c5406a009a5a9c43e', '9adb74216b75a090d7b8764453146efc9480942bedc0616c5406a009a5a9c43e'],
  };
  return corpus.map(({ original, ...sample }) => {
    assert.equal(sha256(original), frozen[sample.id][0], 'frozen original corpus SHA');
    assert.equal(sha256(sample.input), frozen[sample.id][1], 'frozen selected corpus SHA');
    return { ...sample, originalSha256: sha256(original), originalBytes: original.length, inputSha256: sha256(sample.input), inputBytes: sample.input.length };
  });
}
