import { inflateSync } from 'node:zlib';
import { OfficeError } from './errors.mjs';
const fail=()=>{throw new OfficeError('OFFICE_UNSAFE_IMAGE','office.unsafeImage');};
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit+=1)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
/** Validate bounded, non-interlaced PNG bytes without accepting a path or URL. */
export function validatePngData(value){
 if(typeof value!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail();
 const bytes=Buffer.from(value.slice('data:image/png;base64,'.length),'base64');
 if(bytes.length<45||bytes.length>768*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail();
 let offset=8,width=0,height=0,depth=0,color=0,ended=false,palette=false;const compressed=[];
 while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset);if(length>bytes.length-offset-12)fail();const type=bytes.subarray(offset+4,offset+8).toString('ascii');const data=bytes.subarray(offset+8,offset+8+length);if(crc32(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))fail();
  if(offset===8&&type!=='IHDR')fail();
  if(type==='IHDR'){if(width||length!==13)fail();width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8];color=data[9];if(!width||!height||width>4096||height>4096||data[10]!==0||data[11]!==0||data[12]!==0||!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[color]?.includes(depth))fail();}
  else if(type==='PLTE'){if(!length||length%3||length>768)fail();palette=true;}
  else if(type==='IDAT')compressed.push(data);
  else if(type==='IEND'){if(length||offset+12!==bytes.length)fail();ended=true;offset+=12;break;}
  else if(!/^[a-z]/.test(type))fail();
  offset+=length+12;
 }
 if(!ended||!compressed.length||(color===3&&!palette)||offset!==bytes.length)fail();
 const channels=({0:1,2:3,3:1,4:2,6:4})[color];const rowBytes=Math.ceil(width*channels*depth/8)+1;const expected=rowBytes*height;
 if(expected>32*1024*1024)fail();
 let decoded;try{decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected+1});}catch{fail();}
 if(decoded.length!==expected)fail();for(let row=0;row<height;row+=1)if(decoded[row*rowBytes]>4)fail();
 return{width,height};
}
