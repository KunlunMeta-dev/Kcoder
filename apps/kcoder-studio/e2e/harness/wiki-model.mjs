import { startApprovalModelFixture } from './approval-model.mjs';
export function startWikiModelFixture(context, { pageForSource, responseReady } = {}) {
  return startApprovalModelFixture(context, {responseSteps:({body})=>{
    const message=body.messages.filter(message=>message.role==='user').at(-1);
    const text=typeof message.content==='string'?message.content:message.content.map(block=>block.text||'').join('');
    const input=JSON.parse(text);
    let output;
    if (!input.analysis) output={summary:'资料说明产品支持协议 A。',queries:['协议'],conflicts:[]};
    else {
      const source=input.source, chunk=source.chunks[0];
      const review=chunk.text.includes('待审核');
      const page = pageForSource?.(source);
      output={pages:[{pageId:input.newPageIds[0],expectedRevision:null,kind:'concept',title:page?.title ?? (review?'补充协议':'协议兼容性'),markdown:page?.markdown ?? '# 协议兼容性\n\n产品支持协议 A。\n\n## 依据\n\n保留原始资料以便核对。',citations:[{sourceId:source.sourceId,revisionId:source.revisionId,chunkId:chunk.chunkId,quote:chunk.text}],relatedPageIds:[]}],reviewNotes:review?['请核对补充资料的适用条件。']:[]};
    }
    return [{...(responseReady ? {ready:()=>responseReady(input)} : {}),delta:{role:'assistant',content:JSON.stringify(output)},finishReason:'stop'}];
  }});
}
