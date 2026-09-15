import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, status, authDirFor } from '../src/checkin.ts'

describe('WorkBuddy auth directory', () => {
  it('reads %LOCALAPPDATA% on Windows', () => {
    expect(authDirFor('win32',{LOCALAPPDATA:'C:\\Users\\me\\AppData\\Local'},'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Local','CodeBuddyExtension','Data','Public','auth'))
  })
  it('falls back to AppData\\Local when Windows leaves LOCALAPPDATA unset', () => {
    expect(authDirFor('win32',{},'C:\\Users\\me')).toBe(join('C:\\Users\\me','AppData','Local','CodeBuddyExtension','Data','Public','auth'))
  })
  it('keeps Application Support on macOS and Linux', () => {
    expect(authDirFor('darwin',{},'/Users/me')).toBe(join('/Users/me','Library','Application Support','CodeBuddyExtension','Data','Public','auth'))
    expect(authDirFor('linux',{},'/home/me')).toBe(join('/home/me','Library','Application Support','CodeBuddyExtension','Data','Public','auth'))
  })
})

describe('WorkBuddy account discovery', () => {
  it('uses the newest domestic backup per account and ignores WorkBuddy AI', async () => {
    const dir=await mkdtemp(join(tmpdir(),'workbuddy-checkin-'))
    const doc=(uid:string,nickname:string)=>JSON.stringify({account:{uid,nickname},auth:{accessToken:'token',domain:'www.workbuddy.cn'}})
    await writeFile(join(dir,'workbuddy-desktop.2026-09-01T00-00-00-000Z.1.a.info'),doc('a','old'))
    await writeFile(join(dir,'workbuddy-desktop.2026-09-02T00-00-00-000Z.1.a.info'),doc('a','new'))
    await writeFile(join(dir,'workbuddy-desktop.info'),doc('b','current'))
    await writeFile(join(dir,'workbuddy-desktop-ai.2026-09-03T00-00-00-000Z.1.a.info'),doc('ai','must-ignore'))
    expect(await discover(dir)).toMatchObject([{uid:'a',nickname:'new'},{uid:'b',nickname:'current'}])
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
