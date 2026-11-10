/** Executed through use_figma; this module has no browser or product side effects. */
export async function buildEditableScreens(figma, batch, targets, options = {}) {
  if (!options.pageReady) {
    const page=await figma.getNodeByIdAsync(options.pageNodeId || "0:1");await figma.setCurrentPageAsync(page);
  }
  await Promise.all([
    ...["Regular","Medium","Bold"].map(style=>figma.loadFontAsync({family:"Noto Sans SC",style})),
    figma.loadFontAsync({family:"Fira Code",style:"Regular"}),
  ]);
  const createdNodeIds=[],controls=[],roots=[];
  const track=node=>{createdNodeIds.push(node.id);return node;};
  const rgba=value=>{
    const parts=String(value||"").match(/[\d.]+/g)?.map(Number);
    return parts&&parts.length>=3?{color:{r:parts[0]/255,g:parts[1]/255,b:parts[2]/255},opacity:parts[3]??1}:null;
  };
  const paint=value=>{const c=rgba(value);return c&&c.opacity>0?[{type:"SOLID",...c}]:[];};
  const textContent=n=>n.text??n.c.map(textContent).join(" ");
  for(const state of batch){
    const target=targets.find(t=>t.stateId===state.id);
    if(!target)throw new Error(`Missing target ${state.id}`);
    const frame=await figma.getNodeByIdAsync(target.nodeId);
    if(!frame||frame.type!=="FRAME"||!frame.name.startsWith("REF-V3 / "))throw new Error(`Unsafe target ${target.nodeId}`);
    if(frame.children.length&&!state.appendPortals)throw new Error(`Target already has content: ${state.id}`);
    if(state.appendPortals&&frame.children.some(n=>n.name==="REF / Portal layers"))throw new Error(`Portal already imported: ${state.id}`);
    const render=(item,parent,parentBox,inPortal=false)=>{
      const b=item.b,s=item.s;let node;
      if(item.svg){
        node=figma.createNodeFromSvg(item.svg);
        const all=[node,...node.findAll(()=>true)];createdNodeIds.push(...all.map(n=>n.id));
        parent.appendChild(node);node.resize(Math.max(.01,b.w),Math.max(.01,b.h));
      }else if("text"in item){
        node=track(figma.createText());parent.appendChild(node);
        const size=s.size||14,weight=/bold/i.test(s.font||"")?700:s.weight||400;
        const mono=/mono|code|courier|menlo|consolas/i.test(s.font||"");
        node.fontName=mono?{family:"Fira Code",style:"Regular"}:{family:"Noto Sans SC",style:weight>=650?"Bold":weight>=500?"Medium":"Regular"};
        node.fontSize=size;node.lineHeight={unit:"PIXELS",value:s.line||b.h||size*1.4};
        node.letterSpacing={unit:"PIXELS",value:s.letter||0};node.fills=paint(s.color||"rgb(31,39,34)");
        node.textAutoResize="NONE";node.resize(Math.max(1,b.w+2),Math.max(1,b.h+2));node.characters=item.text;
        if(item.tag==="text")node.textAutoResize="WIDTH_AND_HEIGHT";
        if(s.decoration?.includes("line-through"))node.textDecoration="STRIKETHROUGH";
        else if(s.decoration?.includes("underline"))node.textDecoration="UNDERLINE";
        if(item.tag!=="text"){
          const pad=s.pad||[0,0,0,0];node.resize(Math.max(1,b.w-pad[1]-pad[3]),Math.max(1,b.h-pad[0]-pad[2]));
          if(s.align==="center")node.textAlignHorizontal="CENTER";
          const text=node,viewport=track(figma.createFrame());parent.appendChild(viewport);
          viewport.resize(Math.max(1,b.w),Math.max(1,b.h));viewport.fills=paint(s.bg);viewport.clipsContent=true;
          viewport.overflowDirection=item.tag==="textarea"?"VERTICAL":"NONE";
          if(s.radii){viewport.topLeftRadius=s.radii[0];viewport.topRightRadius=s.radii[1];viewport.bottomRightRadius=s.radii[2];viewport.bottomLeftRadius=s.radii[3];}
          if(s.borders){const[w,col]=s.borders;viewport.strokes=paint(col[w.findIndex(v=>v>0)]);viewport.strokeAlign="INSIDE";viewport.strokeTopWeight=w[0];viewport.strokeRightWeight=w[1];viewport.strokeBottomWeight=w[2];viewport.strokeLeftWeight=w[3];}
          viewport.appendChild(text);text.x=pad[3];text.y=pad[0];text.textAutoResize="HEIGHT";node=viewport;
        }
      }else{
        // Native plugins do not expose the MCP createAutoLayout convenience API.
        node=track(figma.createFrame());
        if(s.flex)node.layoutMode=s.flex.startsWith("row")?"HORIZONTAL":"VERTICAL";
        parent.appendChild(node);node.resize(Math.max(.01,b.w),Math.max(.01,b.h));
        if(s.flex){node.layoutSizingHorizontal="FIXED";node.layoutSizingVertical="FIXED";}
        node.fills=paint(s.bg);node.clipsContent=!!s.clip && !item.c.every(c=>c.tag==="text");
        if(s.borders){const[w,col]=s.borders;node.strokes=paint(col[w.findIndex(v=>v>0)]);node.strokeAlign="INSIDE";
          node.strokeTopWeight=w[0];node.strokeRightWeight=w[1];node.strokeBottomWeight=w[2];node.strokeLeftWeight=w[3];}
        if(s.radii){node.topLeftRadius=s.radii[0];node.topRightRadius=s.radii[1];node.bottomRightRadius=s.radii[2];node.bottomLeftRadius=s.radii[3];}
        // Freeze computed coordinates rather than inventing responsive constraints.
        for(const [index,child]of item.c.entries())render(child,node,b,inPortal||(item.tag==="body"&&index>0)||!!state.appendPortals);
      }
      node.name=(item.tag==="text"?"文字 / ":item.tag==="svg"?"图标 / ":item.r==="button"||item.tag==="button"?"按钮 / ":"布局 / ")+(item.l||item.t||item.n);
      if(parent.type==="FRAME"&&parent.layoutMode!=="NONE")node.layoutPositioning="ABSOLUTE";
      node.x=b.x-parentBox.x;node.y=b.y-parentBox.y;
      if(s.opacity!==undefined)node.opacity=s.opacity;
      if(["button","radio","checkbox","menuitem","switch","tab"].includes(item.r)||item.tag==="button"||item.tag==="input"||item.tag==="textarea"
        ||(item.l&&!['text','svg'].includes(item.tag)&&item.r!=="dialog")||/model-selector|composer-model|draft-model|todo-card/.test(item.t||"")){
        controls.push({stateId:state.id,nodeId:node.id,testId:item.t||null,label:item.l||textContent(item).slice(0,100),disabled:!!item.d,tag:item.tag,portal:inPortal||!!state.appendPortals,box:b});
      }
      return node;
    };
    const root=render(state.scene,frame,{x:0,y:0});
    if(state.appendPortals)root.name="REF / Portal layers";
    if("placeholder"in frame)frame.placeholder=false;
    roots.push({stateId:state.id,nodeId:frame.id,descendantCount:frame.findAll(()=>true).length});
  }
  return{createdNodeIds,mutatedNodeIds:roots.map(r=>r.nodeId),roots,controls};
}
