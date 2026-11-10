import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunContext } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { officeCases, validateOfficeCase, readOfficeOutput, validateOfficeWidgets } from './kworker-office-cases.mjs';
test('office oracle rejects wrong arithmetic, uncontained outputs and fabricated provenance', async () => {
  const context = await RunContext.create(import.meta.url,{testId:'office-oracle-negative'});
  try {
    const {path:workspace} = await materializeWorkspace(context,'kworker-office');
    await mkdir(resolve(workspace,'deliverables'));
    await writeFile(resolve(workspace,'deliverables/sales-analysis.md'),'Synthetic 615 CNY and 243 CNY');
    await writeFile(resolve(workspace,'deliverables/sales.json'),JSON.stringify({marker:'m',annualRevenue:615,annualCost:372,annualProfit:244,profitMargin:243/615,quarterRevenue:[128,156,142,189]}));
    await assert.rejects(validateOfficeCase(workspace,officeCases('m')[1],'m'));
    await writeFile(resolve(workspace,'deliverables/research.md'),'pilot-a.md pilot-b.md');
    await writeFile(resolve(workspace,'deliverables/research.json'),JSON.stringify({marker:'m',timeReductionPercent:30,causalConclusion:false,externalCustomersSupported:false,limitations:['sample','causality'],citations:[{source:'sources/pilot-a.md',quote:'Fabricated evidence never in the source'},{source:'sources/pilot-b.md',quote:'Fabricated evidence never in the source'}]}));
    await assert.rejects(validateOfficeCase(workspace,officeCases('m')[2],'m'));
    await writeFile(context.pathInState('outside.txt'),'outside');
    await symlink(context.pathInState('outside.txt'),resolve(workspace,'deliverables/escape.txt'));
    await assert.rejects(readOfficeOutput(workspace,'escape.txt'));
    assert.throws(() => validateOfficeWidgets([]),/actual SVG/);
  } finally { await context.finish('passed',{ok:true}); }
});

test('office result oracles accept independently constructed local arithmetic/source controls', async () => {
  const context = await RunContext.create(import.meta.url,{testId:'office-oracle-controls'});
  try {
    const {path:workspace} = await materializeWorkspace(context,'kworker-office');
    await mkdir(resolve(workspace,'deliverables'));
    const total=560000*1.085**7;
    const controls={
      'meeting-summary.md':'# Meeting\n2026-10-01 pilot; public release undecided. m',
      'meeting.json':JSON.stringify({marker:'m',pilotDate:'2026-10-01',publicRelease:'undecided',pendingQuoteAmount:null,actions:[{owner:'Lin Lan',due:'2026-09-25'},{owner:'Xu Chen',due:'2026-09-28'}]}),
      'sales-analysis.md':'# Sales\n615 revenue and 243 profit, in 10000 CNY.',
      'sales.json':JSON.stringify({marker:'m',annualRevenue:615,annualCost:372,annualProfit:243,profitMargin:243/615,quarterRevenue:[128,156,142,189]}),
      'research.md':'# Research\nSources: pilot-a.md and pilot-b.md. Causality and external-customer generalization remain unproven.',
      'research.json':JSON.stringify({marker:'m',timeReductionPercent:30,causalConclusion:false,externalCustomersSupported:false,limitations:['No external customers','No controlled causality experiment'],citations:[{source:'sources/pilot-a.md',quote:'The pilot measured 12 teams over 6 weeks.'},{source:'sources/pilot-b.md',quote:'Eight of the 12 teams reported easier retrieval; four reported no change.'}]}),
      'presentation.html':'<!doctype html><html><body><section><h2>Observed results</h2>pilot-a.md</section><section><h2>Limits</h2>pilot-b.md</section><section><h2>Next steps</h2>m</section></body></html>',
      'presentation.json':JSON.stringify({marker:'m',sectionCount:3,principal:560000,annualRate:8.5,years:7,total,earnings:total-560000}),
    };
    for(const [file,value] of Object.entries(controls)) await writeFile(resolve(workspace,'deliverables',file),value);
    for(const task of officeCases('m')) assert.equal((await validateOfficeCase(workspace,task,'m')).arithmeticAndProvenanceValidated,true);
    const widgets=[
      {widget:{format:'svg',executionMode:'managed',libraries:[]},source:'<svg><title>Source relation</title></svg>'},
      {widget:{format:'html',executionMode:'managed',libraries:['chart_js']},source:'<script type="application/json" data-kcoder-chart>{"type":"bar","data":{"labels":["Q1","Q2","Q3","Q4"],"datasets":[{"data":[128,156,142,189]}]}}</script>'},
      {widget:{format:'html',executionMode:'managed',libraries:[]},source:'<div data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7,"currency":"CNY"}</script></div>'},
    ];
    assert.equal(validateOfficeWidgets(widgets).compound,true);
  } finally {await context.finish('passed',{ok:true});}
});
