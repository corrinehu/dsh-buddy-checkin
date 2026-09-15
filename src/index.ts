import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { load, refreshBalances, retryFailed, run, status } from './checkin.ts'

export const name='dsh-buddy-checkin'
export const inject=['webServer','clientModules']

type ClientModules = { graph(): { entries: readonly { id: string }[] } }

const local = (value: string | undefined): boolean => value === 'localhost' || value?.startsWith('localhost:') === true || value === '127.0.0.1' || value?.startsWith('127.0.0.1:') === true || value === '[::1]' || value?.startsWith('[::1]:') === true
function trusted(req: IncomingMessage): boolean { if (!local(req.headers.host)) return false; const origin=req.headers.origin; if (origin===undefined) return true; try { return local(new URL(origin).host) } catch { return false } }
function respond(res: ServerResponse, saved: Awaited<ReturnType<typeof load>>): void { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(saved?{...saved,status:status(saved)}:{status:'none',results:[]})) }

export function apply(ctx: Context): void {
  const modules=(ctx as Context & { clientModules: ClientModules }).clientModules
  ctx.logger.info(`client graph includes check-in: ${modules.graph().entries.some(entry=>entry.id==='dsh-buddy-checkin')}`)
  const startup=run().catch(error=>{ctx.logger.warn(error); return undefined})
  ctx.inject(['webServer'], webCtx => webCtx.effect(()=>{
    const disposeStatus=webCtx.webServer.register({
      kind:'exact', path:'/buddy-checkin/status', handler:async(req: IncomingMessage,res: ServerResponse)=>{
        if (!trusted(req)) { res.writeHead(403); res.end(); return }
        if (req.method==='GET') { await startup; respond(res,await load()); return }
        if (req.method==='POST') { await startup; respond(res,await retryFailed()); return }
        res.writeHead(405,{allow:'GET, POST'}); res.end()
      },
    })
    const disposeBalance=webCtx.webServer.register({
      kind:'exact', path:'/buddy-checkin/refresh-balance', handler:async(req: IncomingMessage,res: ServerResponse)=>{
        if (!trusted(req)) { res.writeHead(403); res.end(); return }
        if (req.method==='POST') { await startup; respond(res,await refreshBalances()); return }
        res.writeHead(405,{allow:'POST'}); res.end()
      },
    })
    return ()=>{disposeStatus();disposeBalance()}
  },'dsh-buddy-checkin: status'))
}
