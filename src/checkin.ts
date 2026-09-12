import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Result = { uid:string; nickname?:string; state:'signed'|'already'|'failed'; at:string; credit?:number; balance?:number; error?:string }
type Credential = { uid:string; nickname?:string; accessToken:string; domain:string; enterpriseId?:string }
type Saved = { day:string; checkedAt:string; results:Result[]; notice?:string }
const authDir = () => join(homedir(),'Library','Application Support','CodeBuddyExtension','Data','Public','auth')
export const statePath = () => join(process.env.DSH_HOME ?? join(homedir(),'.dsh'),'.workbuddy-checkin.json')
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
  const r=await fetch(`https://${c.domain}/v2/billing/meter/get-user-resource`,{method:'POST',headers:headers(c),body:JSON.stringify({PageNumber:1,PageSize:100,ProductCode:'p_tcaca',Status:[0,3]})}); const b=await r.json() as any; const a=b?.data?.Response?.Data?.Accounts; return Array.isArray(a) ? a.reduce((n,x)=>n+(typeof x?.CycleCapacityRemain==='number'?x.CycleCapacityRemain:0),0) : undefined
}
export async function check(c:Credential, now=new Date()): Promise<Result> {
  const at=now.toISOString(); try { const r=await fetch(`https://${c.domain}/v2/billing/meter/daily-checkin`,{method:'POST',headers:headers(c),body:'{}'}); const b=await r.json() as any; const already=string(b?.msg)?.includes('已签到') === true; if (!r.ok && !already) throw new Error(String(b?.msg ?? `HTTP ${r.status}`)); const total=await balance(c).catch(()=>undefined); return {uid:c.uid,...c.nickname ? {nickname:c.nickname}:{},state:already?'already':'signed',at,...!already&&typeof b?.data?.credit==='number'?{credit:b.data.credit}:{},...total===undefined?{}:{balance:total}} } catch(e) { return {uid:c.uid,...c.nickname ? {nickname:c.nickname}:{},state:'failed',at,error:e instanceof Error?e.message:String(e)} }
}
// A corrupt or wrong-shaped state file reads as "nothing saved" — the run that
// writes it already succeeded once, so losing the memory must never take down
// a startup check (a truncated write used to escape JSON.parse and kill run()).
function savedDocument(parsed: unknown): Saved | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const d=parsed as Record<string, unknown>
  if (typeof d.day!=='string' || typeof d.checkedAt!=='string' || !Array.isArray(d.results)) return undefined
  return d as unknown as Saved
}
export async function load(path=statePath()): Promise<Saved|undefined> { try { return savedDocument(JSON.parse(await readFile(path,'utf8'))) } catch { return undefined } }
export async function run(): Promise<Saved> { const previous=await load(); const day=today(); const prior=previous?.day===day ? previous.results : []; const completed=new Map(prior.filter(x=>x.state!=='failed').map(x=>[x.uid,x])); const accounts=await discover(); const attempted=await Promise.all(accounts.filter(c=>!completed.has(c.uid)).map(c=>check(c))); const results=accounts.map(c=>completed.get(c.uid)).filter((x):x is Result=>x!==undefined).concat(attempted); const ok=attempted.filter(x=>x.state!=='failed').length; const saved={day,checkedAt:new Date().toISOString(),results,...attempted.length===0?{}:{notice: attempted.some(x=>x.state==='failed') ? `WorkBuddy 签到 ${ok}/${attempted.length} 成功，失败账号将在下次启动重试` : `WorkBuddy 已完成今日签到：${ok} 个账号`}}; await mkdir(dirname(statePath()),{recursive:true}); const temporary=`${statePath()}.tmp`; await writeFile(temporary,JSON.stringify(saved),{mode:0o600}); await rename(temporary,statePath()); return saved }
export const status = (s:Saved) => s.results.length===0?'none':s.results.every(x=>x.state!=='failed')?'ok':s.results.some(x=>x.state!=='failed')?'warn':'error'
