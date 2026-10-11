import { deflateSync } from 'node:zlib';

const DIGITS = {
  '0':['111','101','101','101','111'], '1':['010','110','010','010','111'],
  '2':['111','001','111','100','111'], '3':['111','001','111','001','111'],
  '4':['101','101','111','001','001'], '5':['111','100','111','001','111'],
  '6':['111','100','111','101','111'], '7':['111','001','010','010','010'],
  '8':['111','101','111','101','111'], '9':['111','101','111','001','111'],
  '+':['000','010','111','010','000'],
};
const crcTable = Uint32Array.from({length:256}, (_, index) => {
  let value=index;
  for(let bit=0;bit<8;bit++) value=(value&1)?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function chunk(type,data) {
  const name=Buffer.from(type); let crc=0xffffffff;
  for(const byte of Buffer.concat([name,data])) crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const header=Buffer.alloc(4), tail=Buffer.alloc(4);
  header.writeUInt32BE(data.length); tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,name,data,tail]);
}
/** Generate a local PNG; renderer IPC supplies only a bounded integer, never image bytes. */
export function completionBadgePng(count) {
  if(!Number.isInteger(count)||count<1||count>10000) throw new Error('Invalid completion badge count');
  const size=32, stride=size*4+1, pixels=Buffer.alloc(stride*size);
  const paint=(x,y,value,alpha=255)=>{const i=y*stride+1+x*4;pixels[i]=pixels[i+1]=pixels[i+2]=value;pixels[i+3]=alpha;};
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const coverage=Math.max(0,Math.min(1,15.5-Math.hypot(x-15.5,y-15.5)));
    paint(x,y,24,Math.round(coverage*255));
  }
  const text=count>99?'99+':String(count), scale=text.length===3?2:3;
  const width=text.length*3*scale+(text.length-1)*2;
  const left=Math.floor((size-width)/2), top=Math.floor((size-5*scale)/2);
  [...text].forEach((digit,index)=>DIGITS[digit].forEach((row,y)=>[...row].forEach((pixel,x)=>{
    if(pixel==='1') for(let dy=0;dy<scale;dy++) for(let dx=0;dx<scale;dx++) paint(left+index*(3*scale+2)+x*scale+dx,top+y*scale+dy,255);
  })));
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

export function createTaskbarCompletionBadge({window,nativeImage,platform=process.platform}) {
  let previous=null;
  return {
    update(count,language='zh-CN') {
      if(platform!=='win32'||!nativeImage||typeof window.setOverlayIcon!=='function'||window.isDestroyed()) return;
      const key=`${count}:${language}`;
      if(key===previous) return;
      const description=count ? language==='en' ? `${count} conversation results to review` : `${count} 个会话结果待查看` : '';
      window.setOverlayIcon(count ? nativeImage.createFromBuffer(completionBadgePng(count)) : null,description);
      previous=key;
    },
    clear() { this.update(0); },
  };
}
