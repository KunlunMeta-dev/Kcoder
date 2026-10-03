import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
 testId:'mobile-native-platform-bundles-and-android-apk', tier:'manual-live',
 modelPolicy:'No model calls. Native bundle/APK build only; does not claim device execution.',retainSuccessLogs:true,
},async context=>{
 const sdk=process.env.KCODER_E2E_ANDROID_SDK;
 if(!sdk)throw Error('UNMET_PREREQUISITE: KCODER_E2E_ANDROID_SDK is required');
 const mobile=context.pathInState('source/apps/kcoder-studio/mobile');
 await mkdir(mobile,{recursive:true});
 for(const file of ['src','assets','scripts','app.json','app.config.ts','package.json','package-lock.json','tsconfig.json'])await cp(resolve(appRoot,'mobile',file),resolve(mobile,file),{recursive:true});
 await cp(resolve(appRoot,'shared'),resolve(mobile,'../shared'),{recursive:true});
 await symlink(resolve(appRoot,'mobile/node_modules'),resolve(mobile,'node_modules'),'dir');
 const app=JSON.parse(await readFile(resolve(mobile,'app.json'),'utf8'));
 app.expo.name='KCoder Mobile Audit';app.expo.android.package='dev.kcoder.studio.audit';app.expo.ios.bundleIdentifier='dev.kcoder.studio.audit';
 await writeFile(resolve(mobile,'app.json'),JSON.stringify(app,null,2));
 await writeFile(resolve(mobile,'metro.config.cjs'),`const {getDefaultConfig}=require('expo/metro-config');const c=getDefaultConfig(__dirname);c.watchFolders=[...c.watchFolders,${JSON.stringify(resolve(appRoot,'mobile'))},${JSON.stringify(resolve(appRoot,'shared'))},${JSON.stringify(resolve(mobile,'../shared'))}];module.exports=c;`);
 const env=context.isolatedEnvironment({ANDROID_HOME:sdk,ANDROID_SDK_ROOT:sdk,JAVA_HOME:process.env.KCODER_E2E_JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk-amd64',GRADLE_USER_HOME:resolve(sdk,'gradle-cache'),CI:'1',KCODER_STUDIO_ALLOW_HTTP:'1',EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP:'1'},['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']);
 const run=async(label,cmd,args,timeout)=>{const child=context.spawnOwned(label,cmd,args,{cwd:mobile,env});await waitFor(()=>child.exitCode!==null,timeout,label,500,context.abortSignal);assert.equal(child.exitCode,0,`${label} failed; see owned log`)};
 const expo=resolve(appRoot,'mobile/node_modules/expo/bin/cli');
 await run('native-js-export',process.execPath,[expo,'export','--platform','all','--max-workers','2','--output-dir',context.pathInState('native-export')],240000);
 const metadata=JSON.parse(await readFile(context.pathInState('native-export/metadata.json'),'utf8'));
 assert.ok(metadata.fileMetadata.android && metadata.fileMetadata.ios,'both native platforms must be exported');
 await context.writeArtifactJson('native-export-metadata.json',metadata);
 await run('android-prebuild',process.execPath,[expo,'prebuild','--platform','android','--no-install'],120000);
 await run('android-apk','bash',[resolve(mobile,'android/gradlew'),'-p',resolve(mobile,'android'),':app:assembleRelease','--no-daemon','--console=plain','--max-workers=4','-PreactNativeArchitectures=x86_64'],900000);
 const apk=resolve(mobile,'android/app/build/outputs/apk/release/app-release.apk');
 assert.ok((await stat(apk)).size>1000000);
 const artifact=context.pathInArtifacts('kcoder-mobile-audit-x86_64.apk');await cp(apk,artifact);
 await context.writeArtifactJson('android-build.json',{applicationId:app.expo.android.package,apk:artifact,abi:"x86_64",cleartextTestOnly:true,deviceExecution:false});
 return {androidApk:true,iosHermesBundle:true,deviceExecution:false};
});
