import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Result = { uid:string; nickname?:string; state:'signed'|'already'|'failed'; at:string; credit?:number; balance?:number; balanceCheckedAt?:string; balanceError?:string; error?:string }
type Credential = { uid:string; nickname?:string; accessToken:string; domain:string; enterpriseId?:string }
export type Saved = { day:string; checkedAt:string; balanceCheckedAt?:string; results:Result[]; notice?:string }
/** The shared login store WorkBuddy's desktop app writes: Application Support on macOS, %LOCALAPPDATA% on Windows. */
export const authDirFor = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string => platform === 'win32'
  ? join(env.LOCALAPPDATA ?? join(home,'AppData','Local'),'CodeBuddyExtension','Data','Public','auth')
  : join(home,'Library','Application Support','CodeBuddyExtension','Data','Public','auth')
const authDir = () => authDirFor()
export const statePath = () => join(process.env.DSH_HOME ?? join(homedir(),'.dsh'),'.buddy-checkin.json')
/** Pre-rename state file, read as a fallback so upgrading keeps today's results (next save writes the new path). */
const legacyStatePath = (path: string): string | undefined => path.endsWith('.buddy-checkin.json') ? path.replace(/\.buddy-checkin\.json$/u,'.workbuddy-checkin.json') : undefined
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())

function string(v: unknown): string | undefined { return typeof v === 'string' && v !== '' ? v : undefined }
function credential(raw: unknown): Credential | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const d=raw as Record<string, unknown>; const a=d.account as Record<string,unknown>|undefined; const auth=d.auth as Record<string,unknown>|undefined
  const uid=string(a?.uid); const accessToken=string(auth?.accessToken); const domain=string(auth?.domain) ?? string((a?.domain as Record<string,unknown>|undefined)?.domain)
  const nickname = string(a?.nickname)
  return uid && accessToken && domain ? {uid,accessToken,domain,...nickname === undefined ? {} : {nickname}} : undefined
}
export async function discover(dir=authDir()): Promise<Credential[]> {
  const files=await readdir(dir).catch(()=>[] as string[]); const latest=new Map<string,{c:Credential; name:string}>()
  for(const name of files) { if (!(name==='workbuddy-desktop.info'||/^workbuddy-desktop\.\d{4}-/u.test(name))) continue; let raw: unknown=null; try { raw=JSON.parse(await readFile(join(dir,name),'utf8')) } catch {} const c=credential(raw); if(c && (latest.get(c.uid)?.name ?? '') < name) latest.set(c.uid,{c,name}) }
  return [...latest.values()].map(x=>x.c)
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
export async function refreshBalances(path=statePath(), accounts?:Credential[]): Promise<Saved|undefined> {
  const previous=await load(path)
  if (!previous) return undefined
  const discovered=accounts ?? await discover()
  const accountByUid=new Map(discovered.map(account=>[account.uid,account]))
  const results=await Promise.all(previous.results.map(async result=>{
    const account=accountByUid.get(result.uid)
    if (account===undefined) return {...result,balanceError:'未找到登录凭据，显示上次记录'}
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
export async function run(path=statePath()): Promise<Saved> {
  const previous=await load(path); const day=today(); const sameDay=previous?.day===day; const prior=sameDay ? previous.results : []; const completed=new Map(prior.filter(x=>x.state!=='failed').map(x=>[x.uid,x])); const accounts=await discover(); const attempted=await Promise.all(accounts.filter(c=>!completed.has(c.uid)).map(c=>check(c))); const results=accounts.map(c=>completed.get(c.uid)).filter((x):x is Result=>x!==undefined).concat(attempted); const ok=attempted.filter(x=>x.state!=='failed').length
  return save({day,checkedAt:new Date().toISOString(),results,...sameDay&&previous?.balanceCheckedAt?{balanceCheckedAt:previous.balanceCheckedAt}:{},...attempted.length===0?{}:{notice: attempted.some(x=>x.state==='failed') ? `WorkBuddy 签到 ${ok}/${attempted.length} 成功，失败账号可在面板中重试` : `WorkBuddy 已完成今日签到：${ok} 个账号`}},path)
}
/** The panel only retries accounts that failed in today's startup attempt. */
export async function retryFailed(path=statePath()): Promise<Saved> {
  const previous=await load(path)
  if (!previous || previous.day!==today()) return run(path)
  const accounts=await discover()
  const accountByUid=new Map(accounts.map(account=>[account.uid,account]))
  const retried=await Promise.all(previous.results.filter(result=>result.state==='failed').flatMap(result=>{const account=accountByUid.get(result.uid); return account===undefined?[]:[check(account)]}))
  const replacements=new Map(retried.map(result=>[result.uid,result]))
  const results=accounts.flatMap(account=>{const result=replacements.get(account.uid) ?? previous.results.find(item=>item.uid===account.uid); return result===undefined?[]:[result]})
  return save({day:previous.day,checkedAt:new Date().toISOString(),results,...previous.balanceCheckedAt?{balanceCheckedAt:previous.balanceCheckedAt}:{}},path)
}
export const status = (s:Saved) => s.results.length===0?'none':s.results.every(x=>x.state!=='failed')?'ok':s.results.some(x=>x.state!=='failed')?'warn':'error'
