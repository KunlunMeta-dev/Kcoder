import {useEffect,useState} from 'react';
import {Text,View} from 'react-native';
import {Button} from '@/components/ui';
import {t} from '@/i18n';
import {useThemedStyles} from '@/theme';
import type {MobileMigrationClient,MigrationCalls} from '@/runtime/migration-client';
import type {MigrationConfigurationLayersTarget} from '../../../../../../shared/generated/contracts';
import {makeStyles,PageControls} from '../migration-result-ui';
type Result=MigrationCalls['codexLayersRead'][1];
export function MigrationCodexLayerReport({client,target}:{client:MobileMigrationClient;target:MigrationConfigurationLayersTarget}) {
  const styles=useThemedStyles(makeStyles),scope=JSON.stringify(target);
  const [open,setOpen]=useState<{client:MobileMigrationClient;scope:string}|null>(null),[page,setPage]=useState({scope,index:0});
  const [state,setState]=useState<{client:MobileMigrationClient;scope:string;index:number;value?:Result;error?:boolean}|null>(null);
  const index=page.scope===scope?page.index:0,expanded=open?.client===client&&open.scope===scope;
  useEffect(()=>{if(!expanded||!client.available())return;let active=true;void client.call('codexLayersRead',{target,pageIndex:index}).then(value=>{if(active&&client.available())setState({client,scope,index,value})},()=>{if(active&&client.available())setState({client,scope,index,error:true})});return()=>{active=false}},[client,scope,index,expanded]);
  const current=state?.client===client&&state.scope===scope&&state.index===index&&client.available()?state:null,value=current?.value;
  const label=(layer:number)=>{const row=value?.layers[layer];return row?t(`migration_codex.${row.kind}`,{n:row.kind==='project'?value!.layers.slice(0,layer+1).filter(item=>item.kind==='project').length:0}):''};
  const move=(next:number)=>{if(client.available()){setState(null);setPage({scope,index:next})}};
  if(!client.supports('codexLayersRead'))return null;
  return <View style={styles.stack} testID="migration-codex-report">
    <Button testID="migration-codex-report-toggle" variant="ghost" onPress={()=>{if(client.available())setOpen(expanded?null:{client,scope})}}>{t('migration_codex.title')}</Button>
    {expanded?<View testID="migration-codex-report-details" style={styles.stack}>
      <Text style={styles.note}>{t('migration_codex.boundary')}</Text>
      {!current?<Text style={styles.note}>{t('migration_layers.loading')}</Text>:null}
      {current?.error?<Text accessibilityRole="alert" style={styles.error}>{t('migration_layers.failed')}</Text>:null}
      {value&&value.status!=='available'?<Text style={styles.note}>{t(`migration_layers.${value.status}`)}</Text>:null}
      {value?.status==='available'?<>
        <Text style={styles.note}>{value.layers.map(layer=>`${label(layer.index)}: ${t(layer.present?'migration_layers.present':'migration_layers.absent')}`).join(' · ')}</Text>
        <Text style={styles.note}>{t('migration_codex.precedence')}</Text>
        {value.fields.map((field,i)=><View key={i} style={styles.row} testID="migration-codex-field">
          <Text selectable style={styles.text}>{field.field??t('migration_layers.unknown',{n:index*10+i+1})}{field.providerIndex!=null?` · ${t('migration_codex.provider',{n:field.providerIndex+1})}`:''}</Text>
          <Text style={styles.note}>{t(field.ignored?'migration_codex.ignored':field.supported?'migration_layers.supported':'migration_layers.unsupported')}{field.private?` · ${t('migration_layers.private')}`:''}</Text>
          <Text style={styles.note}>{t('migration_codex.origin')}: {label(field.layer)}</Text>
        </View>)}
        <Text style={styles.note}>{t('migration_layers.unobserved')}: {value.unobserved.map(name=>t(`migration_codex.${name}`)).join('、')}</Text>
        <Text style={styles.note}>{t('migration_layers.page',{page:index+1,total:value.totalFields})}</Text>
        <PageControls previous={index>0} next={value.nextPage!=null} onPrevious={()=>move(index-1)} onNext={()=>{if(value.nextPage!=null)move(value.nextPage)}}/>
      </>:null}
    </View>:null}
  </View>;
}
