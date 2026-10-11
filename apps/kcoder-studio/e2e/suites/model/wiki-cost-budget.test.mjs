import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assertWikiBinaryIdentity, assertWikiWireControls, finiteWikiCaseQueue, finiteWikiWallBudget, pairedWikiProvider, privateWikiReviewCheckpoint, privateWikiReviewNotes, wikiCandidateGates, wikiFactCoverage, wikiOrganizationDiagnostics, wikiOrganizationMetadata, wikiOriginalInput, wikiOwnedSourceBinding, wikiPacketRepairKind, wikiPhysicalLineCount, wikiReviewDiagnostics, wikiSupportBindingFacts, wikiWireStage, WIKI_COST_COMPARISON_SPEC } from './wiki-cost-budget.mjs';

test('finite model-independent clock gate includes corpus preparation and reserves cleanup', () => {
  let clock = 1000;
  const budget = finiteWikiWallBudget(clock, () => clock);
  assert.equal(budget.remaining(), 470000);
  clock += 9000; // Public downloads, import and independent worker startup.
  assert.equal(budget.remaining(), 461000);
  clock += 461000;
  assert.equal(budget.remaining(), 0);
  clock += 9000;
  assert.equal(budget.remaining(), 0);
  assert.ok(budget.elapsed() < budget.wallMs);
});

test('finite model-independent clock gate rejects a cleanup reserve that consumes the wall quota', () => {
  assert.throws(() => finiteWikiWallBudget(0, Date.now, 480000, 480000));
});

test('fixtureNoExternalCalls: fixed v17 comparison profiles share the same 12288 ceiling and strip late overrides', () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = () => { externalCalls++; throw Error('Network is prohibited in configuration fixture'); };
  try {
    const input = { api_format: 'anthropic_messages', default_model: 'MiniMax-M3', context_window_tokens: 200000,
      extra_body: { thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 65536 } };
    const before = pairedWikiProvider(input, 'http://127.0.0.1:1/before');
    const after = pairedWikiProvider(input, 'http://127.0.0.1:1/after');
    assert.deepEqual({ ...before, endpoint: '' }, { ...after, endpoint: '' });
    assert.equal(before.max_output_tokens, 12288);
    assert.equal(before.reasoning_effort, 'none');
    assert.equal(before.output_headroom_tokens, 16384);
    assert.equal(before.extra_body, undefined);
    assert.equal(input.extra_body.max_tokens, 65536, 'approved input object is not mutated');
    assertWikiWireControls({ model: 'MiniMax-M3', max_tokens: 12288 });
    assertWikiWireControls({ model: 'MiniMax-M3', max_tokens: 8192, thinking: { type: 'disabled' } });
    assert.throws(() => assertWikiWireControls({ model: 'MiniMax-M3', max_tokens: 12289 }));
    assert.throws(() => assertWikiWireControls({ model: 'MiniMax-M3', max_tokens: 12288, thinking: { type: 'enabled' } }));
    assert.equal(WIKI_COST_COMPARISON_SPEC.callCeiling, 24);
    assert.equal(WIKI_COST_COMPARISON_SPEC.providerRetries, 0);
    assert.equal(WIKI_COST_COMPARISON_SPEC.auditId, 'v20-final-paired-12288-once-four-workers');
    assertWikiBinaryIdentity('before', 'd93d8a5b8dafa26d28b110ea72bdf97635fd3f88bec5144cb7d3280bacaba846');
    assertWikiBinaryIdentity('after', 'e32c0b261f86ff821fc8bff7c08d381659fd95950621bcd957512c5f7e5a31f9');
    assert.throws(() => assertWikiBinaryIdentity('before', WIKI_COST_COMPARISON_SPEC.afterSha256));
    assert.throws(() => assertWikiBinaryIdentity('custom', WIKI_COST_COMPARISON_SPEC.beforeSha256));
    assert.throws(() => assertWikiBinaryIdentity('after', '0'.repeat(64)));
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('new four-case candidate gate is independent of immutable baseline failures while legacy all-eight stays unchanged',()=>{
  const rows=Array.from({length:4},()=>({arm:'before',validCandidate:false,exactCitations:0,invalidCitations:0}));
  rows.push(...Array.from({length:4},()=>({arm:'after',validCandidate:true,exactCitations:1,invalidCitations:0})));
  assert.deepEqual(wikiCandidateGates(rows),{completeCandidateGate:false,newWorkerCandidateGate:true,baselineObservedCandidateCount:0});
  rows[7].invalidCitations=1; assert.equal(wikiCandidateGates(rows).newWorkerCandidateGate,false);
  rows[0].validCandidate=true; assert.equal(wikiCandidateGates(rows).baselineObservedCandidateCount,1);
});

test('proof-only and plan-only packets resolve owned source from actual binding without source or cross-arm guessing',()=>{
  const packet={repairKind:'organization_proof',sourceInventory:{binding:{sourceId:'owned',sourceRevision:'r',libraryId:'lib'}},pageLineBindings:[{pageId:'p',lines:[{line:1,text:'private'}]}]};
  assert.equal(wikiWireStage(packet),'organization_repair'); assert.equal(wikiPacketRepairKind(packet),'organization_proof');
  assert.deepEqual(wikiOwnedSourceBinding(packet),{sourceId:'owned',revisionId:'r',libraryId:'lib'});
  const response={organizationProof:{placements:[{pageId:'p',allLines:true}]}};
  const diagnostic=wikiOrganizationDiagnostics(response,packet.sourceInventory,'model_response',packet.pageLineBindings);
  assert.equal(diagnostic.returnedModelPageCount,0); assert.equal(diagnostic.pageLineOrigin,'actual_owned_pageLineBindings');
  assert.equal(diagnostic.placementRanges[0].targetPhysicalLines,1); assert.ok(!JSON.stringify(diagnostic).includes('private'));
  assert.equal(wikiWireStage({repairKind:'organization_plan',originalInput:{source:{sourceId:'owned',revisionId:'r'}}}),'format_repair');
  assert.throws(()=>wikiOwnedSourceBinding({source:{sourceId:'wrong'},sourceInventory:packet.sourceInventory}));
  assert.throws(()=>wikiOwnedSourceBinding({}));
});

test('model-independent review diagnostics retain only actual static support codes and located fields', () => {
  const prefix='Source support requires review: page owned (topic). ';
  const result=wikiReviewDiagnostics([
    prefix+'unit 0: no supporting citation was selected (wiki_support_evidence_missing at /units/0/citationIndices)',
    prefix+'unit 8: a selected citation does not belong to this page (wiki_support_evidence_out_of_range at /units/3/citationIndices/1)',
    prefix+'unit 9: too many supporting citations were selected (wiki_support_evidence_too_many at /units/4/citationIndices)',
    'Model commentary (wiki_support_evidence_missing at /units/0/citationIndices)',
    prefix+'unsupported scope without a located code',
  ]);
  assert.deepEqual(result.map(diagnostic => diagnostic.errorType),['wiki_support_evidence_missing','wiki_support_evidence_out_of_range','wiki_support_evidence_too_many']);
  assert.equal(result[1].field,'/units/3/citationIndices/1');
  assert.equal(wikiReviewDiagnostics([prefix+'(arbitrary_model_value at /units/0/citationIndices)']).length,0);
});

test('model-independent support binding fixture counts one indexed citation copy and actual per-unit allowed indices', () => {
  const input={candidate:{pages:[{pageId:'a',markdown:'claim'},{pageId:'b',markdown:'claim'}]},
    citationBindings:[{pageId:'a',citations:[{index:0},{index:1}]},{pageId:'b',citations:[{index:0}]}],
    units:[{pageId:'a',unit:0,allowedCitationIndices:[0,1]},{pageId:'b',unit:0,allowedCitationIndices:[0]}]};
  const facts=wikiSupportBindingFacts(input);
  assert.equal(facts.bindingPages,2); assert.equal(facts.bindingCitations,3); assert.equal(facts.candidateCitationFields,0);
  assert.equal(facts.offeredUnits,2); assert.equal(facts.allowedIndicesPresent,true); assert.equal(facts.allowedIndicesMatchBindings,true);
  input.units[1].allowedCitationIndices=[1];
  assert.equal(wikiSupportBindingFacts(input).allowedIndicesMatchBindings,false);
});

test('model-independent semantic-check stage remains distinct from query repair or generation', () => {
  assert.equal(wikiWireStage({ repairKind: 'source_support', source: {}, candidate: {}, units: [] }), 'source_support');
  assert.equal(wikiWireStage({ analysis: {}, source: {} }), 'generation');
  assert.equal(wikiWireStage({ originalInput: { source: {} }, previousResponse: '{}' }), 'format_repair');
  assert.equal(wikiWireStage({ originalInput: { source: {} }, validationErrors: [] }), 'citation_repair');
  assert.equal(wikiWireStage({ repairKind:'organization_gap',originalInput:{source:{},analysis:{}},pendingProposal:{} }), 'organization_repair');
});

test('model-independent organization plan/proof evidence does not become a semantic completeness verdict', () => {
  const metadata=wikiOrganizationMetadata({ organizationPlan:{aspects:[{aspectId:'purpose-0',unitIds:['u']}],units:[{unitId:'u',disposition:'required'},{unitId:'v',disposition:'uncertain'}]},
    organizationProof:{placements:[{unitId:'u',pageId:'topic',firstLine:1,lastLine:2,citationRefs:['span']}],hostBodyHashes:{topic:'hash'}} });
  assert.equal(metadata.aspectCount,1); assert.equal(metadata.plannedUnitCount,2);
  assert.equal(metadata.dispositions.required,1); assert.equal(metadata.dispositions.uncertain,1);
  assert.equal(metadata.placedUnitCount,1); assert.equal(metadata.hostBodyHashCount,1);
  assert.equal(Object.hasOwn(metadata,'complete'),false);
});

test('bounded nonprose diagnosis records actual inventory membership and ranges without leaking model values', () => {
  const privateId='PRIVATE_MODEL_ID_DO_NOT_EXPOSE', privateProse='PRIVATE_PROSE_DO_NOT_EXPOSE';
  const inventory={complete:true,units:[{id:'u0'},{id:'u1'}],aspects:[{id:'a0'}]};
  const packet={organizationPlan:{units:[{unitId:'u0',purposeAspectIds:['a0']},{unitId:privateId,purposeAspectIds:['bad']}],
    aspects:[{aspectId:'a0',unitIds:['u0',privateId]}]},pages:[{pageId:privateId,markdown:privateProse+'\r\nsecond\n'}],
    organizationProof:{placements:[{unitId:privateId,pageId:privateId,firstLine:0,lastLine:5,citationRefs:[privateId]},
      {unitId:'u0',pageId:privateId,firstLine:privateProse,lastLine:1}]} };
  const before=JSON.stringify(packet),facts=wikiOrganizationDiagnostics(packet,inventory);
  assert.equal(facts.offeredInventory.units,2); assert.equal(facts.offeredInventory.aspects,1);
  assert.equal(facts.returnedPlan.unitMembership.unknown,1); assert.equal(facts.returnedPlan.unitAspectMembership.unknown,1);
  assert.equal(facts.pageLines[0].physicalLines,2);
  assert.equal(facts.placementRanges[0].firstLine,0); assert.equal(facts.placementRanges[0].lastLine,5);
  assert.equal(facts.placementRanges[0].explicitRangeWithinBody,false);
  assert.equal(facts.placementRanges[1].firstLine,null); assert.equal(facts.placementRanges[1].firstLineType,'string');
  assert.ok(!JSON.stringify(facts).includes('PRIVATE_')); assert.equal(JSON.stringify(packet),before,'no range coercion');
});

test('physical line counts match empty, trailing LF and CRLF Markdown without inventing ranges', () => {
  assert.equal(wikiPhysicalLineCount(''),0); assert.equal(wikiPhysicalLineCount('\n'),1);
  assert.equal(wikiPhysicalLineCount('a\n\n'),2); assert.equal(wikiPhysicalLineCount('a\r\nb\r\n'),2);
  const packet={pages:[{pageId:'p',markdown:'a\nb\n'}],organizationProof:{placements:[{pageId:'p',allLines:true}]}};
  const model=wikiOrganizationDiagnostics(packet,null,'model_response');
  assert.equal(model.allLinesTrueCount,1); assert.equal(model.placementRanges[0].firstLine,null);
  assert.equal(model.placementRanges[0].explicitRangeWithinBody,null);
  const canonical=wikiOrganizationDiagnostics({pages:packet.pages,organizationProof:{placements:[{pageId:'p',allLines:true,firstLine:1,lastLine:2}]}},null,'actual_support_request');
  assert.equal(canonical.origin,'actual_support_request'); assert.equal(canonical.placementRanges[0].explicitRangeCoversWholeBody,true);
  const fractional=wikiOrganizationDiagnostics({pages:packet.pages,organizationProof:{placements:[{pageId:'p',firstLine:1.5,lastLine:2}]}},null);
  assert.equal(fractional.placementRanges[0].firstLine,1.5); assert.equal(fractional.placementRanges[0].explicitRangeWithinBody,false);
});

test('diagnosis bounds page/placement arrays and suppresses unsafe or oversized numeric scalars', () => {
  const packet={pages:Array.from({length:70},(_,index)=>({pageId:String(index),markdown:'line'})),
    organizationProof:{placements:Array.from({length:200},()=>({pageId:'0',firstLine:2**50,lastLine:Infinity,allLines:true}))}};
  const facts=wikiOrganizationDiagnostics(packet,null);
  assert.equal(facts.pageLines.length,64); assert.equal(facts.pagesOmitted,6);
  assert.equal(facts.placementRanges.length,192); assert.equal(facts.placementsOmitted,8);
  assert.equal(facts.placementRanges[0].firstLine,null); assert.equal(facts.placementRanges[0].firstLineScalarOmitted,true);
  assert.equal(facts.placementRanges[0].lastLine,null);
  const malformed=wikiOrganizationDiagnostics({pages:[null],organizationPlan:{units:[null],aspects:[null]},organizationProof:{placements:[null]}},null);
  assert.equal(malformed.pageLines[0].pageType,'null'); assert.equal(malformed.placementRanges[0].placementType,'null');
});

test('fixtureNoExternalCalls: actual private review checkpoint is scoped, stays unapproved and raw source is not topic coverage', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE knowledge_jobs (library_id TEXT, job_id TEXT, status TEXT, checkpoint_json TEXT)');
  const pages = [{ pageId:'raw', kind:'source', markdown:'French BLEU 41.8', citations:[] }];
  const checkpoint = { proposal:{ pages, reviewNotes:['coverage uncertain'] } };
  database.prepare('INSERT INTO knowledge_jobs VALUES (?,?,?,?)').run('owned-library','owned-job','awaiting_review',JSON.stringify(checkpoint));
  try {
    assert.deepEqual(privateWikiReviewCheckpoint(database,'owned-library','owned-job'),checkpoint);
    assert.throws(() => privateWikiReviewCheckpoint(database,'other-library','owned-job'));
    const facts = [['French BLEU', ['41\\.8']]];
    assert.equal(wikiFactCoverage(pages,facts)[0].covered,true);
    assert.equal(wikiFactCoverage(pages,facts,true)[0].covered,false);
    assert.equal(database.prepare('SELECT status FROM knowledge_jobs').get().status,'awaiting_review');
    database.exec("UPDATE knowledge_jobs SET status='completed'");
    assert.throws(() => privateWikiReviewCheckpoint(database,'owned-library','owned-job'));
  } finally { database.close(); }
});

test('v20 scheduling fixtureNoExternalCalls: stable paired queue has at most four workers and never repeats an arm', async () => {
  const queue=['paper-before','paper-after','chinese-before','chinese-after','table-before','table-after','html-before','html-after'];
  let active=0,peak=0;const starts=[],completed=[];
  await finiteWikiCaseQueue(queue,async item=>{starts.push(item);active++;peak=Math.max(peak,active);await new Promise(done=>setTimeout(done,2));active--;completed.push(item);},4);
  assert.deepEqual(starts,queue);assert.equal(peak,4);assert.equal(new Set(completed).size,8);assert.equal(active,0);
  await assert.rejects(finiteWikiCaseQueue(queue,()=>{},5));
});

test('v18 fixtureNoExternalCalls: actual private notes are exact bounded checkpoint values; compound diagnostics contain counts only', () => {
  const notes=['Organization requires review: PRIVATE_ACTUAL_NOTE'];
  assert.deepEqual(privateWikiReviewNotes({reviewNotes:notes},notes),notes);
  assert.throws(()=>privateWikiReviewNotes({reviewNotes:notes},['stale']));
  assert.throws(()=>privateWikiReviewNotes({reviewNotes:['中'.repeat(683)]},['中'.repeat(683)]));
  assert.throws(()=>privateWikiReviewNotes({reviewNotes:Array(17).fill('a')},Array(17).fill('a')));
  const diagnostics=wikiOrganizationDiagnostics({}, {units:[{id:'PRIVATE_ID',kind:'compound',reference:'PRIVATE_PROSE'}],aspects:[{}],complete:true});
  assert.equal(diagnostics.offeredInventory.compoundUnits,1);
  assert.equal(diagnostics.offeredInventory.aspects,1);
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'));
});

test('nested model-independent format repairs keep their actual frozen source owner', () => {
  const original = { source: { sourceId: 'owned-source' } };
  assert.equal(wikiOriginalInput({ originalInput: { originalInput: original } }), original);
  assert.throws(() => wikiOriginalInput({ originalInput: 'untrusted' }));
  let excessive = original;
  for (let count = 0; count < 10; count++) excessive = { originalInput: excessive };
  assert.throws(() => wikiOriginalInput(excessive));
});
