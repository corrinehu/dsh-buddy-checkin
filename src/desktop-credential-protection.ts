// WorkBuddy 5.6+ at-rest credential envelopes ($wbEncrypted).
// Adapted from dsh-workbuddy-connect src/desktop-credential-protection.ts
// (shipped in its 0.6.0; Windows Electron resolution ported from its 0.7.1,
// issues #59/#60 and #66) — keep the two in sync when WorkBuddy changes format.
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
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** One decoded field envelope: exactly what WorkBuddy 5.6.x writes (suite 1). */
export interface WorkBuddyEnvelope { suite:number; keyId:string; nonce:Buffer; authTag:Buffer; ciphertext:Buffer }

/** Env variable pointing at the WorkBuddy Electron binary to spawn as key helper. */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'
/** Platform-default Electron binary; confirmed only on macOS (WorkBuddy 5.6.2). */
const MACOS_ELECTRON_PATH = '/Applications/WorkBuddy.app/Contents/MacOS/Electron'
/** CN app's measured default Windows install location, under %LOCALAPPDATA%. */
const WINDOWS_ELECTRON_DEFAULT_SEGMENTS = ['Programs', 'WorkBuddy', 'WorkBuddy.exe'] as const
const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1024 * 1024
/** Electron `version` file shape, e.g. `37.10.3-24`. */
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
/** CN uninstall DisplayName: `WorkBuddy` or `WorkBuddy 5.6.2`; never `WorkBuddy AI …`. */
const WINDOWS_DISPLAY_NAME_PATTERN = /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u
const WINDOWS_EXE_BASENAME = 'workbuddy.exe'
const DISCOVERY_STEP_TIMEOUT_MS = 3_000
const DISCOVERY_BUDGET_MS = 10_000

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

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell absent from unreadable). */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Registry query seam so tests never spawn reg.exe; the default runs `reg.exe query <root> /s`. */
export type RegistryRootQuery = (root: string, signal: AbortSignal) => Promise<string>
export type ElectronResolutionOptions = { registry?: RegistryRootQuery; discoveryBudgetMs?: number }

/**
 * The Electron binary to spawn, or a diagnosable KeyUnavailableError. Order is
 * the contract: an explicit `WORKBUDDY_ELECTRON_BIN` is used as-is and never
 * falls back; then the platform default (Windows: %LOCALAPPDATA% measured
 * layout); Windows finally falls back to uninstall-registry discovery — the
 * CN product only, and only after every candidate proves the Electron layout.
 */
export async function resolveElectronPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, opts: ElectronResolutionOptions = {}): Promise<string> {
  const configured = env[WORKBUDDY_ELECTRON_BIN_ENV]?.trim()
  if (configured !== undefined && configured !== '') {
    if (!isExecutable(configured)) throw new KeyUnavailableError(`WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：${configured}`)
    return configured
  }
  if (platform === 'darwin') {
    if (!isExecutable(MACOS_ELECTRON_PATH)) throw new KeyUnavailableError('未找到 WorkBuddy 的 Electron 二进制（默认路径不可用，可能 App 装在别处）；可用 WORKBUDDY_ELECTRON_BIN 指定')
    return MACOS_ELECTRON_PATH
  }
  if (platform !== 'win32') throw new KeyUnavailableError('此平台没有默认的 WorkBuddy Electron 路径；请用 WORKBUDDY_ELECTRON_BIN 指定其 Electron 二进制')
  const localAppData = env.LOCALAPPDATA?.trim()
  const platformDefault = localAppData === undefined || localAppData === '' ? undefined : join(localAppData, ...WINDOWS_ELECTRON_DEFAULT_SEGMENTS)
  if (platformDefault !== undefined && isExecutable(platformDefault)) return platformDefault
  return await discoverWindowsElectron(env, opts)
}

/**
 * Resolve the CN app's Electron through Windows uninstall records. Registry
 * entries are hints, not trust: every DisplayIcon candidate must still be the
 * product's exe with the known Electron layout before it is executed. Ported
 * from dsh-workbuddy-connect (its #59/#60, with the #66 asar-safe layout
 * check), simplified to the single CN product this plugin scans.
 */
async function discoverWindowsElectron(env: NodeJS.ProcessEnv, opts: ElectronResolutionOptions): Promise<string> {
  const registry = opts.registry ?? defaultRegistryRootQuery(env)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS)
  try {
    const candidates: string[] = []
    let unresolved = false
    for (const root of WINDOWS_REGISTRY_ROOTS) {
      let output: string
      try { output = await registry(root, controller.signal) } catch { unresolved = true; continue }
      const parsed = parseWindowsRegistryOutput(output)
      candidates.push(...parsed.candidates)
      unresolved ||= parsed.incomplete
    }
    const seen = new Map<string, string>()
    const rejected: string[] = []
    for (const candidate of new Set(candidates)) {
      const inspection = inspectWindowsElectronCandidate(candidate)
      if (inspection === 'unresolved') { unresolved = true; continue }
      if (inspection === undefined) { rejected.push(candidate); continue }
      seen.set(inspection.identity, inspection.electronPath)
    }
    if (unresolved) throw new KeyUnavailableError('WorkBuddy 的自动定位未能完成（部分注册表项或候选无法检查）；这不代表未安装，可用 WORKBUDDY_ELECTRON_BIN 指定其 Electron 二进制')
    if (seen.size > 1) {
      const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
      throw new KeyUnavailableError(`找到 ${seen.size} 个 WorkBuddy 安装，无法自动选择：\n${listed}\n可用 WORKBUDDY_ELECTRON_BIN 指定其一`)
    }
    if (seen.size === 1) return [...seen.values()][0]!
    // #66 wording: "nothing was found" and "candidates were found but each failed the
    // layout check" are different diagnoses. The counts stay, the candidate paths
    // deliberately do not — this text reaches the panel.
    throw new KeyUnavailableError(rejected.length === 0
      ? '未找到 WorkBuddy 的 Electron 二进制（默认位置与 Windows 卸载记录均未命中）；可用 WORKBUDDY_ELECTRON_BIN 指定'
      : `Windows 卸载记录找到 ${rejected.length} 个 WorkBuddy 候选，但${rejected.length > 1 ? '均' : '其'}不符合预期的应用布局（exe 旁应有 version 文件与 resources\\app.asar）；可用 WORKBUDDY_ELECTRON_BIN 指定其可执行文件`)
  } finally { clearTimeout(timer); controller.abort() }
}

/** Only known missing-key diagnostics can safely make a failed query read as empty. */
function windowsRegistryKeyMissing(stderr: string): boolean {
  const detail = stderr.trim()
  return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail)
    || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail)
}

/** The real registry source: `reg.exe query <root> /s` under a per-step timeout, abandoned when the shared budget runs out. */
export function defaultRegistryRootQuery(env: NodeJS.ProcessEnv = process.env): RegistryRootQuery {
  const systemRoot = env.SystemRoot?.trim()
  const regPath = systemRoot === undefined || systemRoot === '' ? undefined : join(systemRoot, 'System32', 'reg.exe')
  return (root, signal) => new Promise<string>((resolve, reject) => {
    if (regPath === undefined) { reject(new Error('SystemRoot 未配置，无法定位 reg.exe')); return }
    if (signal.aborted) { reject(new Error('发现预算已耗尽，reg.exe 未启动')); return }
    let settled = false
    const child = execFile(regPath, ['query', root, '/s'], { maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES, timeout: DISCOVERY_STEP_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (settled) return
      settled = true
      // `reg query` exit 1 covers more than a missing key; only a confirmed missing-key diagnostic may read as "no entries", every other failure stays an error.
      if (error !== null && error !== undefined) {
        if (error.killed !== true && (error.code === 1 || error.code === '1') && windowsRegistryKeyMissing(stderr)) { resolve(''); return }
        reject(new Error(`reg.exe 未能完成（${error.killed === true ? '超时' : String(error.code ?? '不可用')}）`)); return
      }
      resolve(stdout)
    })
    const abort = (): void => { if (settled) return; settled = true; child.kill(); reject(new Error('发现预算已耗尽，reg.exe 被放弃')) }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Parse `reg query ... /s` value columns into DisplayIcon candidates. Entries
 * are filtered by the CN DisplayName before the icon is judged, so another
 * product's records — however broken — are excluded as decisively not ours
 * and can never mark this product's search incomplete.
 */
function parseWindowsRegistryOutput(output: string): { candidates: string[]; incomplete: boolean } {
  const entries = new Map<string, { displayName?: string; displayIcon?: string }>()
  let currentKey: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line)
    if (keyMatch !== null) { currentKey = keyMatch[1]!; entries.set(currentKey, {}); continue }
    if (currentKey === undefined) continue
    const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line)
    if (valueMatch === null) continue
    const entry = entries.get(currentKey)
    if (entry === undefined) continue
    if (valueMatch[1]!.toLowerCase() === 'displayname') entry.displayName = valueMatch[2] ?? ''
    else entry.displayIcon = valueMatch[2] ?? ''
  }
  const candidates: string[] = []
  let incomplete = false
  for (const entry of entries.values()) {
    if (entry.displayName === undefined) continue
    if (!WINDOWS_DISPLAY_NAME_PATTERN.test(entry.displayName.trim())) continue
    const displayIcon = entry.displayIcon === undefined ? undefined : parseWindowsDisplayIcon(entry.displayIcon)
    if (displayIcon === undefined) incomplete = true
    else candidates.push(displayIcon)
  }
  return { candidates, incomplete }
}

/** Read a quoted DisplayIcon path and drop the Windows icon-index suffix. */
function parseWindowsDisplayIcon(value: string): string | undefined {
  const raw = value.trim()
  let path: string
  if (raw.startsWith('"')) {
    const closingQuote = raw.indexOf('"', 1)
    if (closingQuote < 0) return undefined
    const suffix = raw.slice(closingQuote + 1).trim()
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return undefined
    path = raw.slice(1, closingQuote).replace(/,\d+$/u, '')
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw)
    if (match === null) return undefined
    path = match[1]!
  }
  path = path.trim()
  return /\.exe$/iu.test(path) ? path : undefined
}

/**
 * Validate the known Windows layout for the app's exe. `undefined` is a
 * decidable exclusion; `'unresolved'` is reserved for errors that prevent
 * checking.
 */
function inspectWindowsElectronCandidate(electronPath: string): { electronPath: string; identity: string } | 'unresolved' | undefined {
  if (basename(electronPath).toLowerCase() !== WINDOWS_EXE_BASENAME) return undefined
  let binaryStat
  try { binaryStat = statSync(electronPath) } catch (error) { return isENOENT(error) ? undefined : 'unresolved' }
  if (!binaryStat.isFile()) return undefined
  try { accessSync(electronPath, constants.X_OK) } catch (error) { return isENOENT(error) ? undefined : 'unresolved' }
  const installRoot = dirname(electronPath)
  let version: string
  try { version = readFileSync(join(installRoot, 'version'), 'utf8').trim() } catch (error) { return isENOENT(error) ? undefined : 'unresolved' }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined
  try {
    // The archive path must not go through fs.stat: under an Electron host (DSH
    // Desktop), asar interception stats app.asar as a directory (isFile() false),
    // which deterministically excluded every registry candidate
    // (dsh-workbuddy-connect #66). Listing the real resources directory is
    // asar-independent — identical on plain Node and inside Electron.
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined
  } catch (error) { return isENOENT(error) ? undefined : 'unresolved' }
  let identity: string
  try { identity = realpathSync(electronPath) } catch (error) { return isENOENT(error) ? undefined : 'unresolved' }
  // Windows paths are case-insensitive even when a registry entry preserved a different casing.
  return { electronPath, identity: identity.toLowerCase() }
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

/** The real source: resolve the binary on this machine (explicit env → platform default → Windows registry discovery), spawn it once, take its payload. */
export async function defaultKeySource(): Promise<string> {
  return await spawnPayload(await resolveElectronPath())
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
