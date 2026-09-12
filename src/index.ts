import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { run, load, status } from './checkin.ts'
export const name='dsh-workbuddy-checkin'; export const inject=['webServer']
const local = (value: string | undefined): boolean => value === 'localhost' || value?.startsWith('localhost:') === true || value === '127.0.0.1' || value?.startsWith('127.0.0.1:') === true || value === '[::1]' || value?.startsWith('[::1]:') === true
function trusted(req: IncomingMessage): boolean { if (!local(req.headers.host)) return false; const origin=req.headers.origin; if (origin===undefined) return true; try { return local(new URL(origin).host) } catch { return false } }
export function apply(ctx: Context): void { void run().catch(error=>ctx.logger.warn(error)); ctx.inject(['webServer'], webCtx => webCtx.effect(()=>webCtx.webServer.register({kind:'exact',path:'/workbuddy-checkin/status',handler:async(req: IncomingMessage,res: ServerResponse)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return} if(!trusted(req)){res.writeHead(403);res.end();return} const saved=await load(); res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(saved?{...saved,status:status(saved)}:{status:'none',results:[]}))}}),'dsh-workbuddy-checkin: status')) }
