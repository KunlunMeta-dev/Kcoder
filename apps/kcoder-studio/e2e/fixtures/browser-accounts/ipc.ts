const scope = {accountId:'layout-account',targetId:'layout-native',workspaceId:null,identityGeneration:'g',targetRevision:'r'}
let items = Array.from({length:11},(_,index)=>({draft:{id:`profile-${index}`,label:['政务材料办理','项目资料研究','个人日常事务'][index%3]+` ${index+1}`,accountLabel:index%2?'单位办公账户':'独立网站登录',purpose:index%2?'business':'personal'},revision:1,archived:false}))
export async function invoke(command:string,args:Record<string,unknown>) {
  if(command!=='embedded_browser_profiles') throw new Error('LAYOUT_FIXTURE_HAS_NO_BROWSER_OR_NATIVE_PROVIDER')
  const payload=args.payload as Record<string,unknown>
  if(args.action==='save') {
    const profile={draft:payload.draft as typeof items[number]['draft'],revision:1,archived:false}
    items=[profile,...items]
    return {available:true,targetId:'layout',targetLabel:'当前计算机',scope,profile}
  }
  if(args.action!=='list') throw new Error('LAYOUT_FIXTURE_UNSUPPORTED_ACTION')
  const offset=payload.after==='page-2'?10:0
  return {available:true,targetId:'layout',targetLabel:'当前计算机',scope,page:{items:items.slice(offset,offset+10),nextCursor:offset===0&&items.length>10?'page-2':null}}
}
