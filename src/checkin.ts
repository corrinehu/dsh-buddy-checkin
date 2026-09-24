import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { openAuthField, parseEnvelope, protectorKey, type KeySource, type WorkBuddyEnvelope } from './desktop-credential-protection.ts'

export type Result = { uid:string; nickname?:string; state:'signed'|'already'|'failed'; at:string; credit?:number; balance?:number; balanceCheckedAt?:string; balanceError?:string; error?:string }
type Credential = { uid:string; nickname?:string; accessToken:string; domain:string; enterpriseId?:string }
export type Saved = { day:string; checkedAt:string; balanceCheckedAt?:string; results:Result[]; notice?:string }
/** An account visible in the auth directory whose credential could not be read (encrypted under a key this machine no longer has, or an unrecognized format). */
export type Unreadable = { uid:string; reason:string }
export type Discovery = { credentials:Credential[]; unreadable:Unreadable[] }
export type DiscoveryOptions = { keySource?:KeySource }
/** Windows prefers Local, with Roaming for older desktop versions. */
export function authDirsFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const bases=platform==='win32'
    ? [env.LOCALAPPDATA || join(home,'AppData','Local'),env.APPDATA || join(home,'AppData','Roaming')]
    : [platform==='darwin' ? join(home,'Library','Application Support') : join(home,'.config')]
  return [...new Set(bases.map(base=>join(base,'CodeBuddyExtension','Data','Public','auth')))]
}
export const authDirFor = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string => authDirsFor(platform,env,home)[0]!
export const statePath = () => join(process.env.DSH_HOME ?? join(homedir(),'.dsh'),'.buddy-checkin.json')
/** Pre-rename state file, read as a fallback so upgrading keeps today's results (next save writes the new path). */
const legacyStatePath = (path: string): string | undefined => path.endsWith('.buddy-checkin.json') ? path.replace(/\.buddy-checkin\.json$/u,'.workbuddy-checkin.json') : undefined
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())

function string(v: unknown): string | undefined { return typeof v === 'string' && v !== '' ? v : undefined }
/**
 * One backup file reduced to what discovery needs. `uid` and `domain` stay
 * plaintext in WorkBuddy 5.6's encrypted files; only the token (and nickname)
 * are sealed, so an encrypted backup is still attributable to its account.
 * `token`/`tokenEnvelope` are mutually exclusive; neither being set means the
 * token field is present but is neither a string nor a decodable envelope.
 */
type Candidate = { name:string; uid:string; domain:string; nickname?:string; token?:string; tokenEnvelope?:WorkBuddyEnvelope; nicknameEnvelope?:WorkBuddyEnvelope }
function candidate(name: string, raw: unknown): Candidate | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const d=raw as Record<string, unknown>; const a=d.account as Record<string,unknown>|undefined; const auth=d.auth as Record<string,unknown>|undefined
  const uid=string(a?.uid); const domain=string(auth?.domain) ?? string((a?.domain as Record<string,unknown>|undefined)?.domain)
  if (!uid || !domain) return undefined
  const token=string(auth?.accessToken)
  const tokenEnvelope=token===undefined ? parseEnvelope(auth?.accessToken) : undefined
  const nickname=string(a?.nickname)
  const nicknameEnvelope=nickname===undefined ? parseEnvelope(a?.nickname) : undefined
  return { name,uid,domain,...token===undefined?{}:{token},...tokenEnvelope===undefined?{}:{tokenEnvelope},...nickname===undefined?{}:{nickname},...nicknameEnvelope===undefined?{}:{nicknameEnvelope} }
}
/** Best credential for one uid: newest file first, skipping encrypted backups this machine's key cannot open. */
function resolveUid(files: readonly Candidate[], key: { key:Buffer; keyId:string } | undefined, keyError: string | undefined): { credential?:Credential; reason?:string } {
  for (const f of files) {
    if (f.token!==undefined) return { credential:{ uid:f.uid,domain:f.domain,accessToken:f.token,...f.nickname===undefined?{}:{nickname:f.nickname} } }
    if (f.tokenEnvelope!==undefined && key!==undefined && key.keyId===f.tokenEnvelope.keyId) {
      const token=openAuthField(key.key,f.tokenEnvelope)
      if (token===undefined) continue
      const nickname=f.nicknameEnvelope===undefined ? undefined : openAuthField(key.key,f.nicknameEnvelope)
      return { credential:{ uid:f.uid,domain:f.domain,accessToken:token,...nickname===undefined||nickname===''?{}:{nickname} } }
    }
  }
  const encrypted=files.some(f=>f.tokenEnvelope!==undefined)
  const reason=encrypted && keyError!==undefined ? `凭据已加密，${keyError}`
    : encrypted ? '凭据由旧密钥加密，当前 WorkBuddy 无法解开（可能为重装 App 前的备份）；在 WorkBuddy App 重新登录该账号可恢复'
    : '凭据文件格式无法识别；在 WorkBuddy App 重新登录该账号可恢复'
  return { reason }
}
/**
 * Discover every account that ever signed in on this machine, each uid with
 * its newest *usable* credential. Since WorkBuddy 5.6 the desktop app seals
 * `accessToken` (and `nickname`) into `$wbEncrypted` envelopes; those are
 * opened with the machine's current key, obtained by spawning the app's own
 * Electron once (see desktop-credential-protection.ts). An encrypted backup
 * the key cannot open falls back to that uid's older plaintext files; a uid
 * with no usable file at all is reported in `unreadable` instead of silently
 * disappearing.
 */
export async function discover(dirs:string|readonly string[]=authDirsFor(), opts:DiscoveryOptions={}): Promise<Discovery> {
  let accumulated:Unreadable[] = []
  for (const dir of typeof dirs==='string' ? [dirs] : dirs) {
    const files=await readdir(dir).catch(()=>[] as string[])
    const groups=new Map<string,Candidate[]>()
    for(const name of files) {
      if (!(name==='workbuddy-desktop.info'||/^workbuddy-desktop\.\d{4}-/u.test(name))) continue
      let raw: unknown=null
      try { raw=JSON.parse(await readFile(join(dir,name),'utf8')) } catch {}
      const c=candidate(name,raw)
      if(c===undefined) continue
      const list=groups.get(c.uid) ?? []; list.push(c); groups.set(c.uid,list)
    }
    if (groups.size===0) continue
    // Newest per uid first; `workbuddy-desktop.info` sorts above any timestamped backup, matching the previous comparator.
    for (const list of groups.values()) list.sort((x,y)=> y.name<x.name ? -1 : y.name>x.name ? 1 : 0)
    // One key resolution per directory at most, and only when an encrypted candidate exists.
    let key:{ key:Buffer; keyId:string }|undefined; let keyError:string|undefined
    if ([...groups.values()].some(list=>list.some(c=>c.tokenEnvelope!==undefined))) {
      try { key=await protectorKey(opts.keySource) } catch(e) { keyError=e instanceof Error?e.message:String(e) }
    }
    const credentials:Credential[]=[]; const unreadable:Unreadable[]=[]
    for (const [uid,list] of groups) {
      const resolved=resolveUid(list,key,keyError)
      if (resolved.credential!==undefined) credentials.push(resolved.credential)
      else unreadable.push({uid,reason:resolved.reason ?? '凭据无法读取'})
    }
    if (credentials.length>0) {
      // A later directory's plaintext may rescue a uid an earlier one could not open; never let an account vanish.
      const rescued=new Set(credentials.map(c=>c.uid))
      return { credentials, unreadable:[...accumulated,...unreadable].filter(u=>!rescued.has(u.uid)) }
    }
    accumulated=[...accumulated,...unreadable]
  }
  return { credentials:[], unreadable:accumulated }
}
function headers(c:Credential): Record<string,string> { return {'content-type':'application/json','authorization':`Bearer ${c.accessToken}`,'x-user-id':c.uid,'x-domain':c.domain,...c.enterpriseId ? {'x-enterprise-id':c.enterpriseId,'x-tenant-id':c.enterpriseId} : {}} }
async function balance(c:Credential): Promise<number|undefined> {
  const r=await fetch(`https://${c.domain}/v2/billing/meter/get-user-resource`,{method:'POST',headers:headers(c),signal:AbortSignal.timeout(15000),body:JSON.stringify({PageNumber:1,PageSize:100,ProductCode:'p_tcaca',Status:[0,3]})}); const b=await r.json() as any; const a=b?.data?.Response?.Data?.Accounts; return r.ok && (b?.code===undefined || b.code===0) && Array.isArray(a) ? a.reduce((n,x)=>n+(typeof x?.CycleCapacityRemain==='number'?x.CycleCapacityRemain:0),0) : undefined
}
export async function check(c:Credential, now=new Date()): Promise<Result> {
  const at=now.toISOString(); try { const r=await fetch(`https://${c.domain}/v2/billing/meter/daily-checkin`,{method:'POST',headers:headers(c),body:'{}'}); const b=await r.json() as any; const already=string(b?.msg)?.includes('已签到') === true; if (!r.ok && !already) throw new Error(String(b?.msg ?? `HTTP ${r.status}`)); const total=await balance(c).catch(()=>undefined); return {uid:c.uid,...c.nickname ? {nickname:c.nickname}:{},state:already?'already':'signed',at,...!already&&typeof b?.data?.credit==='number'?{credit:b.data.credit}:{},...total===undefined?{}:{balance:total}} } catch(e) { return {uid:c.uid,...c.nickname ? {nickname:c.nickname}:{},state:'failed',at,error:e instanceof Error?e.message:String(e)} }
}
function savedDocument(parsed: unknown): Saved | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const d=parsed as Record<string, unknown>
  if (typeof d.day!=='string' || typeof d.checkedAt!=='string' || !Array.isArray(d.results)) return undefined
  return d as unknown as Saved
}
export async function load(path=statePath()): Promise<Saved|undefined> {
  try { return savedDocument(JSON.parse(await readFile(path,'utf8'))) } catch {}
  const legacy=legacyStatePath(path)
  if (legacy===undefined) return undefined
  try { return savedDocument(JSON.parse(await readFile(legacy,'utf8'))) } catch { return undefined }
}
async function save(saved: Saved, path=statePath()): Promise<Saved> {
  await mkdir(dirname(path),{recursive:true})
  const temporary=`${path}.tmp`
  await writeFile(temporary,JSON.stringify(saved),{mode:0o600})
  await rename(temporary,path)
  return saved
}
/** Refresh balances without repeating the daily check-in. */
export async function refreshBalances(path=statePath(), accounts?:Credential[], opts:DiscoveryOptions={}): Promise<Saved|undefined> {
  const previous=await load(path)
  if (!previous) return undefined
  let discovered:Credential[]; let unreadableByUid=new Map<string,string>()
  if (accounts===undefined) { const d=await discover(authDirsFor(),opts); discovered=d.credentials; unreadableByUid=new Map(d.unreadable.map(u=>[u.uid,u.reason])) }
  else discovered=accounts
  const accountByUid=new Map(discovered.map(account=>[account.uid,account]))
  const results=await Promise.all(previous.results.map(async result=>{
    const account=accountByUid.get(result.uid)
    if (account===undefined) return {...result,balanceError: unreadableByUid.get(result.uid) ?? '未找到登录凭据，显示上次记录'}
    const total=await balance(account).catch(()=>undefined)
    return total===undefined ? {...result,balanceError:'余额查询失败，显示上次记录'} : {...result,balance:total,balanceCheckedAt:new Date().toISOString()}
  }))
  // Balance observations are response-only: never overwrite concurrent check-in writes.
  const latest=await load(path)
  if (!latest || latest.day!==previous.day) return latest
  const observations=new Map(results.map(result=>[result.uid,result]))
  return {...latest,results:latest.results.map(result=>{
    const observed=observations.get(result.uid)
    if (!observed) return result
    return {...result,...observed.balance===undefined?{}:{balance:observed.balance},...observed.balanceCheckedAt?{balanceCheckedAt:observed.balanceCheckedAt}:{},...observed.balanceError?{balanceError:observed.balanceError}:{}}
  })}
}
export async function run(path=statePath(), opts:DiscoveryOptions={}): Promise<Saved> {
  const previous=await load(path); const day=today(); const sameDay=previous?.day===day; const prior=sameDay ? previous.results : []; const completed=new Map(prior.filter(x=>x.state!=='failed').map(x=>[x.uid,x])); const {credentials,unreadable}=await discover(authDirsFor(),opts)
  const attempted=await Promise.all(credentials.filter(c=>!completed.has(c.uid)).map(c=>check(c)))
  const blocked=unreadable.filter(u=>!completed.has(u.uid)).map<Result>(u=>({uid:u.uid,state:'failed',at:new Date().toISOString(),error:u.reason}))
  const tried=[...attempted,...blocked]
  const results=credentials.map(c=>completed.get(c.uid)).filter((x):x is Result=>x!==undefined).concat(tried)
  const ok=tried.filter(x=>x.state!=='failed').length
  return save({day,checkedAt:new Date().toISOString(),results,...sameDay&&previous?.balanceCheckedAt?{balanceCheckedAt:previous.balanceCheckedAt}:{},...tried.length===0?{}:{notice: tried.some(x=>x.state==='failed') ? `WorkBuddy 签到 ${ok}/${tried.length} 成功，失败账号可在面板中重试` : `WorkBuddy 已完成今日签到：${ok} 个账号`}},path)
}
/** The panel only retries accounts that failed in today's startup attempt. */
export async function retryFailed(path=statePath(), opts:DiscoveryOptions={}): Promise<Saved> {
  const previous=await load(path)
  if (!previous || previous.day!==today()) return run(path,opts)
  const {credentials,unreadable}=await discover(authDirsFor(),opts)
  const accountByUid=new Map(credentials.map(account=>[account.uid,account]))
  const retried=await Promise.all(previous.results.filter(result=>result.state==='failed').flatMap(result=>{const account=accountByUid.get(result.uid); return account===undefined?[]:[check(account)]}))
  const replacements=new Map(retried.map(result=>[result.uid,result]))
  const unreadableByUid=new Map(unreadable.map(u=>[u.uid,u.reason]))
  const priorByUid=new Map(previous.results.map(result=>[result.uid,result]))
  const uids=new Set([...accountByUid.keys(),...priorByUid.keys()])
  const results=[...uids].map(uid=>{
    const prior=priorByUid.get(uid)
    if (prior!==undefined && prior.state!=='failed') return prior // already succeeded today; a credential that became unreadable later must not demote it
    const replacement=replacements.get(uid)
    if (replacement!==undefined) return replacement
    if (accountByUid.has(uid)) return prior
    const reason=unreadableByUid.get(uid)
    return reason===undefined ? prior : {uid,state:'failed' as const,at:new Date().toISOString(),error:reason}
  }).filter((x):x is Result=>x!==undefined)
  return save({day:previous.day,checkedAt:new Date().toISOString(),results,...previous.balanceCheckedAt?{balanceCheckedAt:previous.balanceCheckedAt}:{}},path)
}
export const status = (s:Saved) => s.results.length===0?'none':s.results.every(x=>x.state!=='failed')?'ok':s.results.some(x=>x.state!=='failed')?'warn':'error'
