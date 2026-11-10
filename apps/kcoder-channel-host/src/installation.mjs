import channelPlatforms from './channel-platforms.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import { dirname,join } from 'node:path';
import { readFileSync,statSync } from 'node:fs';
import { requireValue } from './errors.mjs';

function packageFact(name, expected, entry) {
    try{
      let directory=dirname(fileURLToPath(import.meta.resolve(entry??name)));
      for(let depth=0;depth<4;depth++,directory=dirname(directory)){
        const file=join(directory,'package.json');let source;
        try{requireValue(statSync(file).size<=16384,'SDK_METADATA_TOO_LARGE');source=JSON.parse(readFileSync(file,'utf8'));}catch{continue;}
        if(source.name!==name)continue;
        const version=String(source.version).replace(/^v/,'');return {packageName:name,version,installed:version===expected,reasonCode:version===expected?null:'SDK_VERSION_MISMATCH'};
      }
      return {packageName:name,version:null,installed:false,reasonCode:'SDK_METADATA_UNAVAILABLE'};
    }catch{return {packageName:name,version:null,installed:false,reasonCode:'SDK_NOT_INSTALLED'};}
}
export function installationFacts() {
  return Object.entries(channelPlatforms).map(([kind, definition]) => {
    const primary = packageFact(definition.sdk, definition.sdkVersion, definition.sdkEntry);
    const dependencies = (definition.additionalSdks ?? []).map(value => packageFact(value.name, value.version));
    // A healthy Stream SDK alone does not establish that the REST adapter can run.
    return { kind, ...([primary, ...dependencies].find(value => !value.installed) ?? primary) };
  });
}
export function assertSdkInstalled(kind){requireValue(installationFacts().find(value=>value.kind===kind)?.installed===true,'SDK_INSTALLATION_UNAVAILABLE','repair_configuration');}
