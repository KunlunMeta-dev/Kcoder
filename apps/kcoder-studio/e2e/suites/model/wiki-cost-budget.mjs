export const WIKI_COST_COMPARISON_SPEC = Object.freeze({
  auditId: 'v20-final-paired-12288-once-four-workers',
  profile: 'kunlunmeta', model: 'MiniMax-M3', apiFormat: 'anthropic_messages',
  outputCeiling: 12288, outputHeadroom: 16384, callCeiling: 24,
  wallMs: 480000, cleanupReserveMs: 10000, providerRetries: 0,
  reasoningEffort: 'none',
  beforeRevision: 'b5e1e8d3c999f4fa52f5fcbe16e27917961964f0',
  afterRevision: '12e7197fa production tree (63295161d v20 defaults 262144, ref-only citation prompts)',
  beforeSha256: 'd93d8a5b8dafa26d28b110ea72bdf97635fd3f88bec5144cb7d3280bacaba846',
  afterSha256: '172e4101fd18d97a37df63d6ace927d09dec5c22ad04131ead4b3614ffe1e075',
});

export async function finiteWikiCaseQueue(items, execute, concurrency=4) {
  if (!Number.isInteger(concurrency)||concurrency<1||concurrency>4) throw Error('Finite Wiki case worker limit');
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(cursor<items.length) { const item=items[cursor++]; await execute(item); }
  }));
}

// Actual notes remain in a separate private artifact. Never export their text
// through public/static diagnostics or substitute prompt constants for a note.
export function privateWikiReviewNotes(proposal, observedNotes) {
  const notes=proposal.reviewNotes;
  if (!Array.isArray(notes)||notes.length>16||notes.some(note=>typeof note!=='string'||Buffer.byteLength(note)>2048)
    ||JSON.stringify(notes)!==JSON.stringify(observedNotes)) throw Error('Actual bounded review notes do not match owned checkpoint');
  return [...notes];
}

export function wikiCandidateGates(rows) {
  const valid=row=>row.validCandidate&&row.exactCitations>0&&row.invalidCitations===0;
  const after=rows.filter(row=>row.arm==='after'),before=rows.filter(row=>row.arm==='before');
  return {completeCandidateGate:rows.every(valid),newWorkerCandidateGate:after.length===4&&after.every(valid),
    baselineObservedCandidateCount:before.filter(row=>row.validCandidate).length};
}

export function wikiPacketRepairKind(value) {
  let current=value;
  for(let depth=0;depth<=8;depth++) {
    if(['organization_plan','organization_proof','organization_gap','source_support'].includes(current?.repairKind)) return current.repairKind;
    if(!current?.originalInput) return null;
    current=current.originalInput;
  }
  throw Error('Owned Wiki repair nesting limit exceeded');
}

export function wikiOwnedSourceBinding(value) {
  const original=wikiOriginalInput(value);
  const binding=original.sourceInventory?.binding ?? original.organizationInventory?.binding;
  const ids=[original.source?.sourceId,binding?.sourceId].filter(id=>id!==undefined);
  const revisions=[original.source?.revisionId,binding?.sourceRevision].filter(id=>id!==undefined);
  if(!ids.length||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==1
    ||revisions.some(id=>typeof id!=='string'||!id)||new Set(revisions).size>1) throw Error('Actual owned source binding is missing or inconsistent');
  return {sourceId:ids[0],revisionId:revisions[0] ?? null,libraryId:binding?.libraryId ?? null};
}

export function wikiOrganizationMetadata(value) {
  const plan=value.organizationPlan, proof=value.organizationProof;
  const dispositions={required:0,context:0,excluded:0,uncertain:0,invalid:0};
  for (const unit of Array.isArray(plan?.units) ? plan.units : []) dispositions[Object.hasOwn(dispositions,unit.disposition) ? unit.disposition : 'invalid']++;
  const placements=Array.isArray(proof?.placements) ? proof.placements : [];
  return { planPresent:!!plan, aspectCount:Array.isArray(plan?.aspects) ? plan.aspects.length : null,
    plannedUnitCount:Array.isArray(plan?.units) ? plan.units.length : null, dispositions,
    proofPresent:!!proof, placementCount:placements.length,
    placedUnitCount:new Set(placements.map(placement => placement.unitId)).size,
    placementReferenceCount:placements.reduce((count,placement) => count+(Array.isArray(placement.citationRefs) ? placement.citationRefs.length : 0),0),
    hostBodyHashCount:proof?.hostBodyHashes ? Object.keys(proof.hostBodyHashes).length : 0 };
}

const MAX_DIAGNOSTIC_PAGES=64, MAX_DIAGNOSTIC_PLACEMENTS=192, MAX_LINE_SCALAR=1048576;
const arrayOrEmpty=value => Array.isArray(value) ? value : [];
const valueType=value => value===undefined ? 'missing' : value===null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function lineScalar(value) {
  return typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=MAX_LINE_SCALAR ? value : null;
}
export function wikiPhysicalLineCount(markdown) {
  if (typeof markdown!=='string') return null;
  if (markdown.length===0) return 0;
  return markdown.split('\n').length-(markdown.endsWith('\n') ? 1 : 0);
}

// All identifiers/prose stay in memory. Public evidence contains positional
// ordinals, bounded range scalars and counts, never arbitrary model values.
export function wikiOrganizationDiagnostics(value, offeredInventory, origin='model_response',pageLineBindings=null) {
  const offeredUnits=Array.isArray(offeredInventory?.units) ? offeredInventory.units : null;
  const offeredAspects=Array.isArray(offeredInventory?.aspects) ? offeredInventory.aspects : null;
  const unitIds=new Set((offeredUnits ?? []).map(unit=>unit?.id).filter(id=>typeof id==='string'));
  const aspectIds=new Set((offeredAspects ?? []).map(aspect=>aspect?.id).filter(id=>typeof id==='string'));
  const plan=value?.organizationPlan, plannedUnits=arrayOrEmpty(plan?.units), plannedAspects=arrayOrEmpty(plan?.aspects);
  const membership=(values,offered,known) => known ? {
    count:values.length, unknown:values.filter(id=>typeof id!=='string'||!offered.has(id)).length,
    duplicates:values.filter(id=>typeof id==='string').length-new Set(values.filter(id=>typeof id==='string')).size,
  } : {count:values.length,unknown:null,duplicates:null};
  const modelPages=arrayOrEmpty(value?.pages);
  const boundLines=Array.isArray(pageLineBindings);
  const pages=boundLines ? pageLineBindings : modelPages,placements=arrayOrEmpty(value?.organizationProof?.placements);
  const pagePhysicalLines=page=>boundLines ? (Array.isArray(page?.lines)?page.lines.length:null) : wikiPhysicalLineCount(page?.markdown);
  const pageLines=pages.slice(0,MAX_DIAGNOSTIC_PAGES).map((page,pageIndex)=>({
    pageIndex,pageType:valueType(page),markdownType:boundLines?'owned_line_bindings':valueType(page?.markdown),physicalLines:pagePhysicalLines(page),
    emptyBody:typeof page?.markdown==='string' ? page.markdown.length===0 : null,
    whitespaceOnlyBody:typeof page?.markdown==='string' ? page.markdown.trim().length===0 : null,
  }));
  const placementRanges=placements.slice(0,MAX_DIAGNOSTIC_PLACEMENTS).map((placement,placementIndex)=>{
    const pageIndex=pages.findIndex(page=>typeof placement?.pageId==='string'&&page?.pageId===placement.pageId);
    const bodyLines=pageIndex>=0 ? pagePhysicalLines(pages[pageIndex]) : null;
    const first=lineScalar(placement?.firstLine),last=lineScalar(placement?.lastLine);
    const explicitRange=first!==null&&last!==null;
    return {placementIndex,placementType:valueType(placement),pageIndex:pageIndex>=0 ? pageIndex : null,targetPhysicalLines:bodyLines,
      firstLine:first,lastLine:last,firstLineType:valueType(placement?.firstLine),lastLineType:valueType(placement?.lastLine),
      firstLineScalarOmitted:typeof placement?.firstLine==='number'&&first===null,
      lastLineScalarOmitted:typeof placement?.lastLine==='number'&&last===null,
      allLines:typeof placement?.allLines==='boolean' ? placement.allLines : null,
      allLinesType:valueType(placement?.allLines),
      explicitRangeWithinBody:explicitRange&&bodyLines!==null ? Number.isInteger(first)&&Number.isInteger(last)&&first>0&&first<=last&&last<=bodyLines : null,
      explicitRangeCoversWholeBody:explicitRange&&bodyLines!==null ? Number.isInteger(first)&&Number.isInteger(last)&&first===1&&last===bodyLines : null};
  });
  return { origin:['model_response','actual_support_request','private_checkpoint','observed_model_proposal'].includes(origin)?origin:'unknown',
    offeredInventory:{units:offeredUnits?.length ?? null,aspects:offeredAspects?.length ?? null,
      compoundUnits:offeredUnits ? offeredUnits.filter(unit=>unit?.kind==='compound').length : null,
      complete:typeof offeredInventory?.complete==='boolean' ? offeredInventory.complete : null},
    returnedPlan:{present:!!plan,units:plannedUnits.length,aspects:plannedAspects.length,
      unitMembership:membership(plannedUnits.map(unit=>unit?.unitId),unitIds,offeredUnits!==null),
      aspectMembership:membership(plannedAspects.map(aspect=>aspect?.aspectId),aspectIds,offeredAspects!==null),
      aspectUnitMembership:membership(plannedAspects.flatMap(aspect=>arrayOrEmpty(aspect?.unitIds)),unitIds,offeredUnits!==null),
      unitAspectMembership:membership(plannedUnits.flatMap(unit=>arrayOrEmpty(unit?.purposeAspectIds)),aspectIds,offeredAspects!==null)},
    pageCount:pages.length,returnedModelPageCount:modelPages.length,pageLineOrigin:boundLines?'actual_owned_pageLineBindings':'packet_markdown',pageLines,pagesOmitted:Math.max(0,pages.length-MAX_DIAGNOSTIC_PAGES),
    placementCount:placements.length,placementRanges,placementsOmitted:Math.max(0,placements.length-MAX_DIAGNOSTIC_PLACEMENTS),
    allLinesTrueCount:placements.filter(placement=>placement?.allLines===true).length,
    numericRangeCount:placements.filter(placement=>lineScalar(placement?.firstLine)!==null&&lineScalar(placement?.lastLine)!==null).length,
  };
}

export function wikiReviewDiagnostics(notes) {
  const diagnostics = [];
  for (const note of notes) {
    if (!note.startsWith('Source support requires review:')) continue;
    for (const match of note.matchAll(/\((wiki_support_evidence_(?:missing|out_of_range|too_many)) at (\/units\/\d+\/citationIndices(?:\/\d+)?)\)/g)) {
      diagnostics.push({ stage:'support_validation', errorType:match[1], field:match[2] });
    }
  }
  return diagnostics;
}

export function wikiSupportBindingFacts(input) {
  const bindings = new Map((input.citationBindings ?? []).map(page => [page.pageId,page.citations ?? []]));
  const units = input.units ?? [];
  return { bindingPages:bindings.size,
    bindingCitations:[...bindings.values()].reduce((sum,citations) => sum+citations.length,0),
    candidateCitationFields:(input.candidate?.pages ?? []).filter(page => Object.hasOwn(page,'citations')).length,
    offeredUnits:units.length,
    allowedIndicesPresent:units.every(unit => Array.isArray(unit.allowedCitationIndices)),
    allowedIndicesMatchBindings:units.every(unit => JSON.stringify(unit.allowedCitationIndices) === JSON.stringify((bindings.get(unit.pageId) ?? []).map(citation => citation.index))),
    organizationSourceUnits:Array.isArray(input.organizationInventory?.units) ? input.organizationInventory.units.length : null,
    organizationPlan:wikiOrganizationMetadata(input),
  };
}

export function wikiWireStage(value) {
  const original = wikiOriginalInput(value);
  const kind=wikiPacketRepairKind(value);
  if(kind==='organization_plan') return 'format_repair';
  if(kind==='organization_proof'||kind==='organization_gap') return 'organization_repair';
  if (original.repairKind === 'source_support') return 'source_support';
  return value.previousResponse !== undefined ? 'format_repair'
    : value.validationErrors !== undefined ? 'citation_repair' : value.analysis ? 'generation' : 'analysis';
}

export function privateWikiReviewCheckpoint(database, libraryId, jobId) {
  const row = database.prepare('SELECT status,checkpoint_json FROM knowledge_jobs WHERE library_id=? AND job_id=?').get(libraryId, jobId);
  if (row?.status !== 'awaiting_review' || typeof row.checkpoint_json !== 'string' || row.checkpoint_json.length > 8388608) throw Error('Owned Wiki review checkpoint is unavailable');
  const checkpoint = JSON.parse(row.checkpoint_json);
  if (!Array.isArray(checkpoint.proposal?.pages) || checkpoint.proposal.pages.length === 0) throw Error('Owned Wiki review checkpoint has no pages');
  return checkpoint;
}

export function wikiFactCoverage(pages, facts, topicsOnly = false) {
  const selected = topicsOnly ? pages.filter(page => ['concept','entity','synthesis','query'].includes(page.kind)) : pages;
  const prose = selected.map(page => page.markdown).join('\n');
  return facts.map(([name, expressions]) => ({ name, covered: expressions.every(expression => new RegExp(expression, 'i').test(prose)) }));
}

export function wikiOriginalInput(value) {
  let current = value;
  for (let depth = 0; depth <= 8; depth++) {
    if (!current || typeof current !== 'object') throw Error('Invalid owned Wiki repair input');
    if (current.originalInput === undefined) return current;
    current = current.originalInput;
  }
  throw Error('Owned Wiki repair nesting limit exceeded');
}

export function assertWikiBinaryIdentity(arm, digest) {
  const expected = arm === 'before' ? WIKI_COST_COMPARISON_SPEC.beforeSha256
    : arm === 'after' ? WIKI_COST_COMPARISON_SPEC.afterSha256 : null;
  if (expected === null || digest !== expected) throw Error('Frozen actual compiled Wiki worker identity violated');
}

export function pairedWikiProvider(publicProvider, endpoint) {
  const provider = { ...publicProvider, endpoint, no_proxy: true,
    reasoning_effort: WIKI_COST_COMPARISON_SPEC.reasoningEffort,
    max_output_tokens: WIKI_COST_COMPARISON_SPEC.outputCeiling,
    output_headroom_tokens: WIKI_COST_COMPARISON_SPEC.outputHeadroom, request_timeout_secs: 95 };
  delete provider.extra_body;
  return provider;
}

export function assertWikiWireControls(body) {
  const spec = WIKI_COST_COMPARISON_SPEC;
  if (body.model !== spec.model || (body.thinking && body.thinking.type !== 'disabled')
    || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || body.max_tokens > spec.outputCeiling) {
    throw Error('Frozen actual Wiki wire controls violated');
  }
}

export function finiteWikiWallBudget(startedAtMs, now = Date.now, wallMs = 480000, cleanupReserveMs = 10000) {
  if (!Number.isFinite(startedAtMs) || cleanupReserveMs <= 0 || cleanupReserveMs >= wallMs) throw Error('Invalid finite Wiki wall budget');
  return {
    remaining: () => Math.max(0, wallMs - cleanupReserveMs - (now() - startedAtMs)),
    elapsed: () => now() - startedAtMs,
    wallMs, cleanupReserveMs,
  };
}
