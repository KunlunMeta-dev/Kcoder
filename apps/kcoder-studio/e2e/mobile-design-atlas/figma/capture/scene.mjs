import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const number = value => Number.parseFloat(value) || 0;
const rounded = value => Math.round(number(value) * 1000) / 1000;

/** Preserve actual visible geometry and semantic controls without repeated CSS defaults. */
export function compactScene(node) {
  if (!node) return null;
  const s=node.style;
  const result={k:node.key,n:node.name,tag:node.tag,b:Object.fromEntries(["x","y","w","h"].map(k=>[k,rounded(node.box[k])]))};
  for(const [key,value]of [["t",node.testId],["l",node.label],["r",node.role],["d",node.disabled]])if(value)result[key]=value;
  const style={};
  if(!["transparent","rgba(0, 0, 0, 0)"].includes(s.backgroundColor))style.bg=s.backgroundColor;
  style.color=node.placeholder?"rgb(120, 132, 125)":s.color;
  const widths=[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth].map(number);
  if(widths.some(Boolean))style.borders=[widths,[s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor]];
  const radii=[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomRightRadius,s.borderBottomLeftRadius].map(number);
  if(radii.some(Boolean))style.radii=radii;
  if(number(s.opacity)!==1)style.opacity=number(s.opacity);
  if(/hidden|auto|scroll/.test(s.overflowX+" "+s.overflowY))style.clip=true;
  if(s.display==="flex")style.flex=s.flexDirection;
  if(["absolute","fixed"].includes(s.position))style.absolute=true;
  if("text"in node){result.text=node.text;style.size=number(s.fontSize);style.font=s.fontFamily;style.weight=number(s.fontWeight);
    style.line=number(s.lineHeight);style.letter=number(s.letterSpacing);style.align=s.textAlign;style.decoration=s.textDecorationLine;
    style.pad=[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(number);}
  if(node.svg)result.svg=node.svg.replace(/(<svg[^>]*?)width="[^"]*"/,(all,prefix)=>`${prefix}width="${result.b.w}"`)
    .replace(/(<svg[^>]*?)height="[^"]*"/,(all,prefix)=>`${prefix}height="${result.b.h}"`);
  result.s=style;result.c=(node.children||[]).map(compactScene);
  return result;
}

export async function writeCompactScenes(inputPath) {
  const input=resolve(inputPath);
  const data=JSON.parse(await readFile(input,"utf8"));
  const output=resolve(dirname(input),"compact");await mkdir(output,{recursive:true});
  const manifest=[];
  for(const state of data.states){
    const compact={id:state.id,title:state.title,group:state.group,scene:compactScene(state.scene.root)};
    const bytes=JSON.stringify(compact);await writeFile(resolve(output,`${state.id}.json`),bytes);
    manifest.push({id:state.id,bytes:Buffer.byteLength(bytes)});
  }
  await writeFile(resolve(output,"manifest.json"),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({states:manifest.length,bytes:manifest.reduce((sum,s)=>sum+s.bytes,0),output}));
}
