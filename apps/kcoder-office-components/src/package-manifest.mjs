import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const PACKAGE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
/** Build contribution consumed by the host packager. No model-facing path API. */
export async function createOfficePackageManifest(root=PACKAGE_ROOT){
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));const lockBytes=await readFile(join(root,'package-lock.json'));const lock=JSON.parse(lockBytes);
 const files=[];let totalBytes=0;
 async function walk(directory){
  const directoryMetadata=await lstat(directory);if(!directoryMetadata.isDirectory()||directoryMetadata.isSymbolicLink())throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(entry.name==='.bin'||entry.name==='.package-lock.json')continue;
   const path=join(directory,entry.name);const metadata=await lstat(path);
   if(metadata.isSymbolicLink()||(!metadata.isFile()&&!metadata.isDirectory()))throw Error('OFFICE_PACKAGE_UNSAFE_ENTRY');
   if(metadata.isDirectory()){await walk(path);continue;}
   if(metadata.size>256*1024*1024-totalBytes)throw Error('OFFICE_PACKAGE_LIMIT');
   const name=relative(root,path).split('\\').join('/');const bytes=await readFile(path);totalBytes+=bytes.length;
   if(files.length>=20000||totalBytes>256*1024*1024)throw Error('OFFICE_PACKAGE_LIMIT');
   files.push({path:name,bytes:bytes.length,sha256:digest(bytes),legal:/\/(?:licen[cs]e|notice|copying)(?:\.|$)/i.test('/'+name)});
  }
 }
 await walk(join(root,'src'));await walk(join(root,'node_modules'));
 for(const name of ['package.json','package-lock.json','README.md']){const bytes=await readFile(join(root,name));files.push({path:name,bytes:bytes.length,sha256:digest(bytes),legal:false});}
 files.sort((left,right)=>left.path.localeCompare(right.path,'en'));
 const dependencies=Object.entries(lock.packages??{}).filter(([path])=>path.startsWith('node_modules/')).map(([path,metadata])=>({path,version:metadata.version,integrity:metadata.integrity??null,license:metadata.license??'unconfirmed'}));
 const output={schemaVersion:1,name:manifest.name,version:manifest.version,nodeMinimumMajor:22,entry:'src/cli.mjs',lockSha256:digest(lockBytes),dependencies,files,totalBytes};
 return {...output,contentSha256:digest(JSON.stringify(output))};
}
export async function verifyOfficePackageManifest(manifest,root=PACKAGE_ROOT){
 if(manifest?.schemaVersion!==1||manifest.entry!=='src/cli.mjs'||!Array.isArray(manifest.files)||manifest.files.length>20000)throw Error('OFFICE_PACKAGE_MANIFEST_INVALID');
 const {contentSha256,...body}=manifest;if(digest(JSON.stringify(body))!==contentSha256)throw Error('OFFICE_PACKAGE_IDENTITY_MISMATCH');
 for(const entry of manifest.files){if(typeof entry.path!=='string'||isAbsolute(entry.path)||entry.path.includes('\\')||entry.path.split('/').some(part=>part==='..'||part==='.'||!part))throw Error('OFFICE_PACKAGE_MANIFEST_INVALID');}
 const actual=await createOfficePackageManifest(root);if(actual.contentSha256!==manifest.contentSha256)throw Error('OFFICE_PACKAGE_IDENTITY_MISMATCH');
 return{status:'verified',contentSha256:manifest.contentSha256,fileCount:manifest.files.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [flag,path,...extra]=process.argv.slice(2);if(flag!=='--output'||!path||!isAbsolute(path)||extra.length)throw Error('Office package manifest requires --output ABSOLUTE_PATH');
 const manifest=await createOfficePackageManifest();await writeFile(path,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
}
