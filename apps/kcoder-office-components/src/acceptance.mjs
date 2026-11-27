import { strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { inspectOfficeParts } from './archive.mjs';
import { OfficeError } from './errors.mjs';
function texts(xml) {
 let output='';const parser=new SaxesParser({xmlns:true});
 parser.on('error',()=>{throw new OfficeError('OFFICE_INVALID_ARCHIVE','office.invalidArchive');});
 parser.on('text',text=>{output+=text;});
 parser.on('opentag',tag=>{if(tag.local==='tab')output+='\t';if(tag.local==='br')output+='\n';});
 parser.on('closetag',tag=>{if(['p','tr','tc'].includes(tag.local))output+='\n';});
 parser.write(xml).close();return output;
}
const invalid=()=>{throw new OfficeError('OFFICE_INVALID_INPUT','office.invalidInput');};
function record(value,allowed,required=[]) {
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(key=>!allowed.includes(key))
  ||required.some(key=>!Object.hasOwn(value,key))||Object.values(Object.getOwnPropertyDescriptors(value)).some(item=>item.get||item.set))invalid();
}
function validateCriteria(criteria,kind) {
 record(criteria,['requiredText','forbiddenText','expectedSlides','expectedCells','minimumCharts','requiredSourceRefs']);
 let count=0;
 for(const key of ['requiredText','forbiddenText','requiredSourceRefs']) {
  if(criteria[key]===undefined)continue;
  if(!Array.isArray(criteria[key])||criteria[key].length>128)invalid();
  for(const value of criteria[key])if(typeof value!=='string'||!value.trim()||value.length>2000)invalid();
  count+=criteria[key].length;
 }
 for(const key of ['expectedSlides','minimumCharts'])if(criteria[key]!==undefined) {
  if(kind!=='pptx'||!Number.isSafeInteger(criteria[key])||criteria[key]<0||criteria[key]>120)invalid();
  count++;
 }
 if(criteria.expectedCells!==undefined) {
  if(kind!=='xlsx'||!Array.isArray(criteria.expectedCells)||criteria.expectedCells.length>512)invalid();
  for(const cell of criteria.expectedCells) {
   record(cell,['sheet','cell','value'],['sheet','cell','value']);
   if(typeof cell.sheet!=='string'||!cell.sheet.trim()||cell.sheet.length>31||typeof cell.cell!=='string'
    ||!/^([A-Z]{1,3})([1-9]\d{0,6})$/.test(cell.cell))invalid();
   const [,column,row]=/^([A-Z]+)(\d+)$/.exec(cell.cell);
   if([...column].reduce((total,char)=>total*26+char.charCodeAt(0)-64,0)>16384||Number(row)>1048576)invalid();
   const value=cell.value;
   if(value!==null&&typeof value!=='boolean'&&!(typeof value==='string'&&value.length<=2000)
    &&!(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value))))invalid();
  }
  count+=criteria.expectedCells.length;
 }
 if(!count||Buffer.byteLength(JSON.stringify(criteria))>32*1024)invalid();
}
/** Criteria must originate in frozen task/source truth, never a model success claim. */
export async function verifyMaterialContent(bytes,kind,criteria){
 validateCriteria(criteria,kind);
 const {parts}=inspectOfficeParts(bytes,kind);let text='';let slides=0;let charts=0;const checks=[];
 if(kind==='docx')text=texts(strFromU8(parts['word/document.xml']));
 if(kind==='pptx'){for(const[name,body]of Object.entries(parts)){if(/^ppt\/slides\/slide\d+\.xml$/.test(name)){slides+=1;text+=texts(strFromU8(body));}if(/^ppt\/charts\/chart\d+\.xml$/.test(name)){charts+=1;text+=texts(strFromU8(body));}if(/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))text+=texts(strFromU8(body));}}
 let book;
 if(kind==='xlsx'){
  let imported;
  try { imported=await import('exceljs'); }
  catch(cause) { throw new OfficeError('OFFICE_DEPENDENCY_UNAVAILABLE','office.dependencyUnavailable','repair_configuration',{cause}); }
  try { book=new(imported.default??imported).Workbook();await book.xlsx.load(Buffer.from(bytes));for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{text+=String(cell.text??'')+'\n';})); }
  catch(cause) { throw new OfficeError('OFFICE_INVALID_ARCHIVE','office.invalidArchive','repair_configuration',{cause}); }
 }
 for(const value of criteria.requiredText??[]){if(typeof value!=='string'||value.length>2000)throw new OfficeError('OFFICE_INVALID_INPUT','office.invalidInput');checks.push({id:'required_text',passed:text.includes(value),expected:value});}
 for(const value of criteria.forbiddenText??[])checks.push({id:'forbidden_text',passed:!text.includes(value),expectedAbsent:value});
 for(const value of criteria.requiredSourceRefs??[])checks.push({id:'source_reference',passed:text.includes(value),expected:value});
 if(criteria.expectedSlides!==undefined)checks.push({id:'slide_count',passed:slides===criteria.expectedSlides,actual:slides,expected:criteria.expectedSlides});
 if(criteria.minimumCharts!==undefined)checks.push({id:'chart_presence',passed:charts>=criteria.minimumCharts,actual:charts,expectedMinimum:criteria.minimumCharts});
 for(const cell of criteria.expectedCells??[]){const sheet=book.getWorksheet(cell.sheet),value=sheet?.getCell(cell.cell).value;checks.push({id:'cell_value',passed:Boolean(sheet)&&value===cell.value,sheet:cell.sheet,cell:cell.cell,actual:value??null,expected:cell.value});}
 return{status:checks.every(check=>check.passed)?'passed':'failed',verificationClass:'deterministic_material_oracle',checks,limitations:['Bounded text/cell/structure checks do not prove a model understood the sources or all page layout is correct.','Reader recalculation and actual business/platform completion are independent observations.']};
}
