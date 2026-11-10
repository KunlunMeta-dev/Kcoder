import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { inspectOffice } from './archive.mjs';
import { OfficeError } from './errors.mjs';
function texts(xml){let output='';const parser=new SaxesParser({xmlns:true});parser.on('error',()=>{throw new OfficeError('OFFICE_INVALID_ARCHIVE','office.invalidArchive');});parser.on('text',text=>{output+=text+'\n';});parser.write(xml).close();return output;}
/** Criteria must originate in frozen task/source truth, never a model success claim. */
export async function verifyMaterialContent(bytes,kind,criteria){
 inspectOffice(bytes,kind);
 if(!criteria||Object.getPrototypeOf(criteria)!==Object.prototype||Object.keys(criteria).some(key=>!['requiredText','forbiddenText','expectedSlides','expectedCells','minimumCharts','requiredSourceRefs'].includes(key))||JSON.stringify(criteria).length>32*1024)throw new OfficeError('OFFICE_INVALID_INPUT','office.invalidInput');
 const parts=unzipSync(bytes);let text='';let slides=0;let charts=0;const checks=[];
 if(kind==='docx')text=texts(strFromU8(parts['word/document.xml']));
 if(kind==='pptx'){for(const[name,body]of Object.entries(parts)){if(/^ppt\/slides\/slide\d+\.xml$/.test(name)){slides+=1;text+=texts(strFromU8(body));}if(/^ppt\/charts\/chart\d+\.xml$/.test(name)){charts+=1;text+=texts(strFromU8(body));}if(/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))text+=texts(strFromU8(body));}}
 let book;
 if(kind==='xlsx'){const imported=await import('exceljs');book=new(imported.default??imported).Workbook();await book.xlsx.load(Buffer.from(bytes));for(const sheet of book.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{text+=String(cell.text??'')+'\n';}));}
 for(const value of criteria.requiredText??[]){if(typeof value!=='string'||value.length>2000)throw new OfficeError('OFFICE_INVALID_INPUT','office.invalidInput');checks.push({id:'required_text',passed:text.includes(value),expected:value});}
 for(const value of criteria.forbiddenText??[])checks.push({id:'forbidden_text',passed:!text.includes(value),expectedAbsent:value});
 for(const value of criteria.requiredSourceRefs??[])checks.push({id:'source_reference',passed:text.includes(value),expected:value});
 if(criteria.expectedSlides!==undefined)checks.push({id:'slide_count',passed:slides===criteria.expectedSlides,actual:slides,expected:criteria.expectedSlides});
 if(criteria.minimumCharts!==undefined)checks.push({id:'chart_presence',passed:charts>=criteria.minimumCharts,actual:charts,expectedMinimum:criteria.minimumCharts});
 for(const cell of criteria.expectedCells??[]){const value=book?.getWorksheet(cell.sheet)?.getCell(cell.cell).value;checks.push({id:'cell_value',passed:value===cell.value,sheet:cell.sheet,cell:cell.cell,actual:value??null,expected:cell.value});}
 return{status:checks.every(check=>check.passed)?'passed':'failed',verificationClass:'deterministic_material_oracle',checks,limitations:['Bounded text/cell/structure checks do not prove a model understood the sources or all page layout is correct.','Reader recalculation and actual business/platform completion are independent observations.']};
}
