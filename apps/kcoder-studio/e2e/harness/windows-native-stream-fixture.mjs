import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode,root]=process.argv.slice(2);
if(!['emit','overflow','timeout'].includes(mode)||!root)throw Error('Finite owned stream fixture required');
if(mode==='overflow'){process.stdout.write('O'.repeat(65536));process.stderr.write('E'.repeat(65536));}
else if(mode==='timeout'){setInterval(()=>{},1000);}
else {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();
  writeFileSync(join(root,'fixture-child.json'),JSON.stringify({pid:child.pid,parentPid:process.pid}));
  process.stdout.write('plain stdout\nUnicode 你好 😀\n\x1b[32mANSI stdout\x1b[0m\n');
  process.stderr.write('plain stderr\nUnicode 错误 🌏\n\x1b[31mANSI stderr\x1b[0m\n#< CLIXML\r\n<Objs><S S="Error">fixture only</S></Objs>\r\nnon-XML tail\n');
  process.exitCode=23;
}
