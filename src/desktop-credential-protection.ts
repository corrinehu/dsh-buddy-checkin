// WorkBuddy 5.6+ at-rest credential envelopes ($wbEncrypted).
// Adapted from dsh-workbuddy-connect src/desktop-credential-protection.ts
// (shipped in its 0.6.0) — keep the two in sync when WorkBuddy changes format.
// Recipe, verified live against WorkBuddy 5.6.2:
//   spawn the app's own Electron with ELECTRON_RUN_AS_NODE=1
//   -> process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()
//   -> {version:1, atRestSecretKey} (canonical base64, 32 bytes, non-zero)
//   -> protectorKey = sha256(atRestSecretKey STRING, 'utf8')  — the string, not decoded bytes
//   -> AES-256-GCM over the field envelope (WBEV1 framing, suite 1), structured
//      AAD from keyId+suite, authTag set explicitly.
// Unlike workbuddy-connect, whose single-account store must open the current
// credential or fail loudly, this plugin scans every historical backup: the
// resolver hands back the machine's current key WITHOUT enforcing a keyId
// match — each envelope (and therefore each account) is matched by the caller,
// and an unopenable backup is skipped, not thrown.
// The key never leaves memory: no disk, no logs; errors carry ids and exit codes only.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** One decoded field envelope: exactly what WorkBuddy 5.6.x writes (suite 1). */
export interface WorkBuddyEnvelope { suite:number; keyId:string; nonce:Buffer; authTag:Buffer; ciphertext:Buffer }

/** Env variable pointing at the WorkBuddy Electron binary to spawn as key helper. */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'
/** Platform-default Electron binary; confirmed only on macOS (WorkBuddy 5.6.2). */
const MACOS_ELECTRON_PATH = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'

/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let decoded: Buffer
  try { decoded = Buffer.from(value, 'base64') } catch { return undefined }
  // Buffer.from is lenient about stray characters; require the round-trip so a
  // tampered envelope is rejected before any key material is involved.
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined
  return length === undefined || decoded.length === length ? decoded : undefined
}

/**
 * Whether a raw value is the 5.6 field wrapper with a decodable envelope:
 * `{$wbEncrypted:1, envelope:<base64 of {suite,keyId,nonce,authTag,ciphertext}>}`.
 * Suite must be 1 — the only scheme 5.6.x defines for credential fields; a
 * future format returns undefined so the caller surfaces "unrecognized"
 * instead of attempting a blind open.
 */
export function parseEnvelope(value: unknown): WorkBuddyEnvelope | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const wrapped = value as Record<string, unknown>
  if (wrapped['$wbEncrypted'] !== 1 || typeof wrapped['envelope'] !== 'string') return undefined
  let inner: unknown
  try { inner = JSON.parse(Buffer.from(wrapped['envelope'], 'base64').toString('utf8')) } catch { return undefined }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined
  const parts = inner as Record<string, unknown>
  const nonce = parseBase64(parts['nonce'], 12)
  const authTag = parseBase64(parts['authTag'], 16)
  const ciphertext = parseBase64(parts['ciphertext'])
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined
  if (typeof parts['suite'] !== 'number' || !Number.isInteger(parts['suite']) || parts['suite'] !== 1) return undefined
  if (typeof parts['keyId'] !== 'string' || !/^[0-9a-f]{16}$/u.test(parts['keyId'])) return undefined
  return { suite: parts['suite'], keyId: parts['keyId'], nonce, authTag, ciphertext }
}

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad` and verified live against 5.6.2.
 * Credential fields are always suite 1 under the `field` framing (WBEV1); no
 * sequence numbers, final byte 0 mirrors the reference's default context.
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  const suiteBytes = Buffer.allocUnsafe(4)
  suiteBytes.writeUInt32BE(suite)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
    lengthPrefixed('WBEV1'), lengthPrefixed('sym-v1'), suiteBytes, lengthPrefixed(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ])
}

/** Open one envelope with a protector key; undefined when it will not open. */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 })
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch { return undefined }
}

/** Seal one field with the exact format `openAuthField` reads. Test helper. */
export function sealAuthFieldForTest(key: Buffer, plaintext: string): { '$wbEncrypted': 1, envelope: string } {
  const keyId = keyIdOf(key)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = { suite: 1, keyId, nonce: nonce.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}

/** The validated `loggerGet()` payload: the sealed at-rest secret. */
export function parseAtRestPayload(text: string): { atRestSecretKey: string } | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>
  if (payload['version'] !== 1) return undefined
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') return undefined
  let decoded: Buffer
  try { decoded = Buffer.from(secret, 'base64') } catch { return undefined }
  if (decoded.length !== 32 || decoded.toString('base64') !== secret || decoded.every(byte => byte === 0)) return undefined
  return { atRestSecretKey: secret }
}

/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** The id envelopes name for a key: sha256(key) hex, first 16 chars. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** The key helper cannot be reached: no binary, spawn failure, or unusable payload. */
export class KeyUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'KeyUnavailableError' }
}

/** Where the raw `loggerGet()` payload text comes from; tests stand one in. */
export type KeySource = () => Promise<string>

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/** The Electron binary to spawn, or a diagnosable KeyUnavailableError. Env override first; no path guessing. */
function resolveElectronPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env[WORKBUDDY_ELECTRON_BIN_ENV]
  if (configured !== undefined && configured !== '') {
    if (!isExecutable(configured)) throw new KeyUnavailableError(`WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：${configured}`)
    return configured
  }
  const platformDefault = platform === 'darwin' ? MACOS_ELECTRON_PATH : undefined
  if (platformDefault === undefined) throw new KeyUnavailableError('此平台没有默认的 WorkBuddy Electron 路径；请用 WORKBUDDY_ELECTRON_BIN 指定其 Electron 二进制')
  if (!isExecutable(platformDefault)) throw new KeyUnavailableError('未找到 WorkBuddy 的 Electron 二进制（默认路径不可用，可能 App 装在别处）；可用 WORKBUDDY_ELECTRON_BIN 指定')
  return platformDefault
}

// One line, run inside WorkBuddy's own Electron as plain Node, where the private
// workbuddyStorage binding exists. It writes nothing else, so stdout is the payload.
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

function spawnPayload(electronPath: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(electronPath, ['-e', HELPER_SCRIPT], { timeout: timeoutMs, maxBuffer: 1_048_576, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} ${error.killed === true ? `超时 ${timeoutMs}ms` : error.code !== undefined ? `退出码 ${error.code}` : '无法启动'}）`))
        return
      }
      const output = stdout.trim()
      if (output === '') { reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} 无输出）`)); return }
      resolve(output)
    })
  })
}

/** The real source: resolve the binary on this machine, spawn it once, take its payload. */
export function defaultKeySource(): Promise<string> {
  return spawnPayload(resolveElectronPath())
}

/** A resolved protector key and the id envelopes name for it. */
export interface ProtectorKey { key: Buffer; keyId: string }

// Success is cached for the default source only (one machine, one key);
// failures are not, so a later call retries after the app appears. Custom
// (test) sources bypass the cache entirely.
let cachedDefault: ProtectorKey | undefined
let inflightDefault: Promise<ProtectorKey> | undefined

/**
 * The machine's current protector key. Deliberately does NOT enforce that
 * envelope key ids match — matching each envelope is the caller's job, so a
 * backup sealed by a previous install can be skipped without failing here.
 */
export async function protectorKey(source?: KeySource): Promise<ProtectorKey> {
  if (source === undefined) {
    if (cachedDefault !== undefined) return cachedDefault
    inflightDefault ??= (async () => {
      const payload = parseAtRestPayload(await defaultKeySource())
      if (payload === undefined) throw new KeyUnavailableError('获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）')
      const key = deriveProtectorKey(payload.atRestSecretKey)
      return { key, keyId: keyIdOf(key) }
    })().finally(() => { inflightDefault = undefined }).then(resolved => { cachedDefault = resolved; return resolved })
    return inflightDefault
  }
  const payload = parseAtRestPayload(await source())
  if (payload === undefined) throw new KeyUnavailableError('获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）')
  const key = deriveProtectorKey(payload.atRestSecretKey)
  return { key, keyId: keyIdOf(key) }
}
