import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, refreshBalances, retryFailed, run, status, authDirFor, authDirsFor } from '../src/checkin.ts'
import { KeyUnavailableError, deriveProtectorKey, sealAuthFieldForTest, type KeySource } from '../src/desktop-credential-protection.ts'

// run()/retryFailed() discover from authDirsFor(), which roots at homedir();
// pointing homedir at a temp dir keeps them hermetic without a production seam.
const { fakeHome } = vi.hoisted(() => ({ fakeHome: { value: '/' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome.value }
})

describe('WorkBuddy auth directory', () => {
  it('reads %LOCALAPPDATA% on Windows', () => {
    expect(authDirFor('win32',{LOCALAPPDATA:'C:\\Users\\me\\AppData\\Local'},'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Local','CodeBuddyExtension','Data','Public','auth'))
  })
  it('falls back to AppData\\Local when Windows leaves LOCALAPPDATA unset', () => {
    expect(authDirFor('win32',{},'C:\\Users\\me')).toBe(join('C:\\Users\\me','AppData','Local','CodeBuddyExtension','Data','Public','auth'))
  })
  it('uses Application Support on macOS and .config on Linux', () => {
    expect(authDirFor('darwin',{},'/Users/me')).toBe(join('/Users/me','Library','Application Support','CodeBuddyExtension','Data','Public','auth'))
    expect(authDirFor('linux',{},'/home/me')).toBe(join('/home/me','.config','CodeBuddyExtension','Data','Public','auth'))
  })
  it('orders Windows Local before Roaming, including environment fallbacks', () => {
    const suffix=['CodeBuddyExtension','Data','Public','auth']
    expect(authDirsFor('win32',{LOCALAPPDATA:'/local',APPDATA:'/roaming'},'/user')).toEqual([join('/local',...suffix),join('/roaming',...suffix)])
    expect(authDirsFor('win32',{},'/user')).toEqual([join('/user','AppData','Local',...suffix),join('/user','AppData','Roaming',...suffix)])
  })
  it('falls back past missing, empty or invalid Local stores and prefers valid Local credentials', async () => {
    const root=await mkdtemp(join(tmpdir(),'checkin-fallback-'))
    const local=join(root,'Local'), roaming=join(root,'Roaming')
    const doc=(nickname:string)=>JSON.stringify({account:{uid:'a',nickname},auth:{accessToken:'token',domain:'example.test'}})
    await mkdir(roaming)
    await writeFile(join(roaming,'workbuddy-desktop.info'),doc('roaming'))
    expect(await discover([local,roaming])).toMatchObject({credentials:[{nickname:'roaming'}]})
    await mkdir(local)
    expect(await discover([local,roaming])).toMatchObject({credentials:[{nickname:'roaming'}]})
    await writeFile(join(local,'workbuddy-desktop.info'),'invalid json')
    expect(await discover([local,roaming])).toMatchObject({credentials:[{nickname:'roaming'}]})
    await writeFile(join(local,'workbuddy-desktop.info'),doc('local'))
    expect(await discover([local,roaming])).toMatchObject({credentials:[{nickname:'local'}]})
  })
})

describe('WorkBuddy 5.6 encrypted credentials', () => {
  const secret=Buffer.from(Array.from({length:32},(_,i)=>i+1)).toString('base64')
  const key=deriveProtectorKey(secret)
  const keySource:KeySource=async()=>JSON.stringify({version:1,atRestSecretKey:secret})
  const otherSecret=Buffer.from(Array.from({length:32},(_,i)=>255-i)).toString('base64')
  const otherKeySource:KeySource=async()=>JSON.stringify({version:1,atRestSecretKey:otherSecret})
  const encryptedDoc=(uid:string,token:string,nickname?:string)=>{
    const account:Record<string,unknown>={uid}
    if(nickname!==undefined) account.nickname=sealAuthFieldForTest(key,nickname)
    return JSON.stringify({account,auth:{accessToken:sealAuthFieldForTest(key,token),domain:'www.workbuddy.cn'}})
  }
  const plaintextDoc=(uid:string,token:string)=>JSON.stringify({account:{uid},auth:{accessToken:token,domain:'www.workbuddy.cn'}})

  it('decrypts the newest encrypted backup, including the sealed nickname', async () => {
    const dir=await mkdtemp(join(tmpdir(),'checkin-enc-'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-01T00-00-00-000Z.1.a.info'),plaintextDoc('a','old-token'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-02T00-00-00-000Z.1.a.info'),encryptedDoc('a','new-token','音策'))
    const source=vi.fn(keySource)
    const d=await discover(dir,{keySource:source})
    expect(d.credentials).toMatchObject([{uid:'a',accessToken:'new-token',nickname:'音策',domain:'www.workbuddy.cn'}])
    expect(d.unreadable).toEqual([])
    expect(source).toHaveBeenCalledTimes(1)
  })
  it('falls back to an older plaintext backup when the current key cannot open the newest envelope', async () => {
    const dir=await mkdtemp(join(tmpdir(),'checkin-enc-'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-01T00-00-00-000Z.1.a.info'),plaintextDoc('a','old-token'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-02T00-00-00-000Z.1.a.info'),encryptedDoc('a','new-token'))
    const d=await discover(dir,{keySource:otherKeySource})
    expect(d.credentials).toMatchObject([{uid:'a',accessToken:'old-token'}])
    expect(d.unreadable).toEqual([])
  })
  it('reports an account as unreadable when no backup can be opened', async () => {
    const dir=await mkdtemp(join(tmpdir(),'checkin-enc-'))
    await writeFile(join(dir,'workbuddy-desktop.info'),encryptedDoc('a','token'))
    const d=await discover(dir,{keySource:otherKeySource})
    expect(d.credentials).toEqual([])
    expect(d.unreadable).toEqual([{uid:'a',reason:expect.stringContaining('重新登录')}])
  })
  it('reports the key-helper failure when the machine key cannot be obtained', async () => {
    const dir=await mkdtemp(join(tmpdir(),'checkin-enc-'))
    await writeFile(join(dir,'workbuddy-desktop.info'),encryptedDoc('a','token'))
    const failing:KeySource=async()=>{throw new KeyUnavailableError('未找到 WorkBuddy 的 Electron 二进制；可用 WORKBUDDY_ELECTRON_BIN 指定')}
    const d=await discover(dir,{keySource:failing})
    expect(d.credentials).toEqual([])
    expect(d.unreadable).toEqual([{uid:'a',reason:expect.stringContaining('凭据已加密')}])
    expect(d.unreadable[0]?.reason).toContain('WORKBUDDY_ELECTRON_BIN')
  })
  it('never asks for a key on plaintext-only machines', async () => {
    const dir=await mkdtemp(join(tmpdir(),'checkin-enc-'))
    await writeFile(join(dir,'workbuddy-desktop.info'),plaintextDoc('a','plain'))
    const source=vi.fn(keySource)
    const d=await discover(dir,{keySource:source})
    expect(d.credentials).toMatchObject([{uid:'a',accessToken:'plain'}])
    expect(source).not.toHaveBeenCalled()
  })
  it('surfaces encrypted-unreadable accounts as failed rows in run()', async () => {
    const root=await mkdtemp(join(tmpdir(),'checkin-run-'))
    fakeHome.value=root
    const authDir=join(root,'Library','Application Support','CodeBuddyExtension','Data','Public','auth')
    await mkdir(authDir,{recursive:true})
    await writeFile(join(authDir,'workbuddy-desktop.info'),encryptedDoc('a','token'))
    const saved=await run(join(root,'state.json'),{keySource:otherKeySource})
    expect(saved.results).toMatchObject([{uid:'a',state:'failed',error:expect.stringContaining('重新登录')}])
    expect(saved.notice).toContain('0/1')
  })
  it('keeps unreadable rows on retry and never demotes today’s signed account', async () => {
    const root=await mkdtemp(join(tmpdir(),'checkin-retry-'))
    fakeHome.value=root
    const authDir=join(root,'Library','Application Support','CodeBuddyExtension','Data','Public','auth')
    await mkdir(authDir,{recursive:true})
    await writeFile(join(authDir,'workbuddy-desktop.info'),encryptedDoc('a','token'))
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())
    const path=join(root,'state.json')
    await writeFile(path,JSON.stringify({day,checkedAt:'x',results:[{uid:'a',state:'failed',at:'x',error:'old'},{uid:'b',state:'signed',at:'x'}]}))
    const out=await retryFailed(path,{keySource:otherKeySource})
    expect(out.results.find(row=>row.uid==='a')).toMatchObject({state:'failed',error:expect.stringContaining('重新登录')})
    expect(out.results.find(row=>row.uid==='b')).toMatchObject({state:'signed'})
  })
})

it('keeps concurrent check-in success on disk and in the balance response', async () => {
  const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
  const path=join(dir,'state.json')
  const before={day:'2026-09-15',checkedAt:'x',results:[{uid:'a',state:'failed',at:'x',balance:1000}]}
  const after={...before,results:[{uid:'a',state:'signed',at:'y',credit:100,balance:900}]}
  await writeFile(path,JSON.stringify(before))
  vi.stubGlobal('fetch',vi.fn(async()=>{
    await writeFile(path,JSON.stringify(after))
    return new Response(JSON.stringify({code:0,data:{Response:{Data:{Accounts:[{CycleCapacityRemain:800}]}}}}))
  }))
  try{
    const result=await refreshBalances(path,[{uid:'a',accessToken:'token',domain:'example.test'}])
    expect(result?.results[0]).toMatchObject({state:'signed',credit:100,balance:800})
    expect(JSON.parse(await readFile(path,'utf8'))).toEqual(after)
  }finally{vi.unstubAllGlobals()}
})

it('marks failed and missing-credential balance queries without claiming an update', async () => {
  const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
  const path=join(dir,'state.json')
  const saved={day:'2026-09-15',checkedAt:'x',results:['a','b'].map(uid=>({uid,state:'already',at:'x',balance:1000}))}
  await writeFile(path,JSON.stringify(saved))
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:401}),{status:401})))
  try{
    const result=await refreshBalances(path,[{uid:'a',accessToken:'token',domain:'example.test'}])
    for(const row of result?.results??[]){
      expect(row.balance).toBe(1000)
      expect(row.balanceError).toBeTypeOf('string')
      expect(row.balanceCheckedAt).toBeUndefined()
    }
    expect(JSON.parse(await readFile(path,'utf8'))).toEqual(saved)
  }finally{vi.unstubAllGlobals()}
})

describe('WorkBuddy account discovery', () => {
  it('uses the newest domestic backup per account and ignores WorkBuddy AI', async () => {
    const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
    const doc=(uid:string,nickname:string)=>JSON.stringify({account:{uid,nickname},auth:{accessToken:'token',domain:'www.workbuddy.cn'}})
    await writeFile(join(dir,'workbuddy-desktop.2026-09-01T00-00-00-000Z.1.a.info'),doc('a','old'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-02T00-00-00-000Z.1.a.info'),doc('a','new'))
    await writeFile(join(dir,'workbuddy-desktop.info'),doc('b','current'))
    await writeFile(join(dir,'workbuddy-desktop-ai.2026-09-03T00-00-00-000Z.1.a.info'),doc('ai','must-ignore'))
    expect(await discover(dir)).toMatchObject({credentials:[{uid:'a',nickname:'new'},{uid:'b',nickname:'current'}]})
  })
  it('makes a partial failure yellow', () => {
    expect(status({day:'2026-09-12',checkedAt:'x',results:[{uid:'a',state:'signed',at:'x'},{uid:'b',state:'failed',at:'x',error:'expired'}]})).toBe('warn')
  })
})

it('treats a missing saved state as first launch', async () => {
  const { load } = await import('../src/checkin.ts')
  expect(await load(join(tmpdir(),'does-not-exist-workbuddy-checkin.json'))).toBeUndefined()
})

it('treats a corrupt or wrong-shaped saved state as first launch instead of crashing', async () => {
  const { load } = await import('../src/checkin.ts')
  const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
  const truncated=join(dir,'truncated.json')
  await writeFile(truncated,'{"day":"2026-09-12","checkedAt":"x","resu')
  expect(await load(truncated)).toBeUndefined()
  const wrongShape=join(dir,'wrong-shape.json')
  await writeFile(wrongShape,JSON.stringify({day:'2026-09-12'}))
  expect(await load(wrongShape)).toBeUndefined()
})

it('marks the day already signed by the upstream message, not its exact spelling', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const url=String(_url)
    if (url.endsWith('/daily-checkin')) return new Response(JSON.stringify({code:10001,msg:'今天已签到，请明天再来',data:null}),{status:400,headers:{'content-type':'application/json'}})
    return new Response(JSON.stringify({code:0,msg:'OK',data:{Response:{Data:{Accounts:[]}}}}),{status:200,headers:{'content-type':'application/json'}})
  }))
  try {
    const { check } = await import('../src/checkin.ts')
    const result=await check({uid:'a',accessToken:'token',domain:'www.workbuddy.cn'})
    expect(result.state).toBe('already')
  } finally { vi.unstubAllGlobals() }
})

it('refreshes balances without calling daily check-in', async () => {
  const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
  const path=join(dir,'state.json')
  await writeFile(path,JSON.stringify({day:'2026-09-15',checkedAt:'2026-09-15T08:00:00.000Z',results:[{uid:'a',state:'already',at:'2026-09-15T08:00:00.000Z',balance:1000}]}))
  const calls:string[]=[]
  vi.stubGlobal('fetch', vi.fn(async (url:unknown) => {
    calls.push(String(url))
    return new Response(JSON.stringify({code:0,data:{Response:{Data:{Accounts:[{CycleCapacityRemain:800}]}}}}),{status:200})
  }))
  try {
    const saved=await refreshBalances(path,[{uid:'a',accessToken:'token',domain:'www.workbuddy.cn'}])
    expect(saved?.checkedAt).toBe('2026-09-15T08:00:00.000Z')
    expect(saved?.results.at(0)?.balanceCheckedAt).toBeTypeOf('string')
    expect(saved?.results.at(0)?.balance).toBe(800)
    expect(calls).toEqual(['https://www.workbuddy.cn/v2/billing/meter/get-user-resource'])
  } finally { vi.unstubAllGlobals() }
})
