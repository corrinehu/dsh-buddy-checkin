import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
//#region src/desktop-credential-protection.ts
/** Env variable pointing at the WorkBuddy Electron binary to spawn as key helper. */
const WORKBUDDY_ELECTRON_BIN_ENV = "WORKBUDDY_ELECTRON_BIN";
/** Platform-default Electron binary; confirmed only on macOS (WorkBuddy 5.6.2). */
const MACOS_ELECTRON_PATH = "/Applications/WorkBuddy.app/Contents/MacOS/Electron";
/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value, length) {
	if (typeof value !== "string" || value === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(value, "base64");
	} catch {
		return;
	}
	if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return void 0;
	return length === void 0 || decoded.length === length ? decoded : void 0;
}
/**
* Whether a raw value is the 5.6 field wrapper with a decodable envelope:
* `{$wbEncrypted:1, envelope:<base64 of {suite,keyId,nonce,authTag,ciphertext}>}`.
* Suite must be 1 — the only scheme 5.6.x defines for credential fields; a
* future format returns undefined so the caller surfaces "unrecognized"
* instead of attempting a blind open.
*/
function parseEnvelope(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const wrapped = value;
	if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return void 0;
	let inner;
	try {
		inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
	} catch {
		return;
	}
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return void 0;
	const parts = inner;
	const nonce = parseBase64(parts["nonce"], 12);
	const authTag = parseBase64(parts["authTag"], 16);
	const ciphertext = parseBase64(parts["ciphertext"]);
	if (nonce === void 0 || authTag === void 0 || ciphertext === void 0) return void 0;
	if (typeof parts["suite"] !== "number" || !Number.isInteger(parts["suite"]) || parts["suite"] !== 1) return void 0;
	if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return void 0;
	return {
		suite: parts["suite"],
		keyId: parts["keyId"],
		nonce,
		authTag,
		ciphertext
	};
}
/**
* The authenticated-context AAD for one field envelope, transcribed from the
* app bundle's `buildAuthenticatedContextAad` and verified live against 5.6.2.
* Credential fields are always suite 1 under the `field` framing (WBEV1); no
* sequence numbers, final byte 0 mirrors the reference's default context.
*/
function buildAuthenticatedContextAad(keyId, suite) {
	const lengthPrefixed = (value) => {
		const bytes = Buffer.from(value, "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(bytes.length);
		return Buffer.concat([header, bytes]);
	};
	const suiteBytes = Buffer.allocUnsafe(4);
	suiteBytes.writeUInt32BE(suite);
	return Buffer.concat([
		Buffer.from("WB-AAD\0", "ascii"),
		Buffer.from([1]),
		lengthPrefixed("WBEV1"),
		lengthPrefixed("sym-v1"),
		suiteBytes,
		lengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/** Open one envelope with a protector key; undefined when it will not open. */
function openAuthField(key, envelope) {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
		decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
		decipher.setAuthTag(envelope.authTag);
		return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return;
	}
}
/** The validated `loggerGet()` payload: the sealed at-rest secret. */
function parseAtRestPayload(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const payload = parsed;
	if (payload["version"] !== 1) return void 0;
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(secret, "base64");
	} catch {
		return;
	}
	if (decoded.length !== 32 || decoded.toString("base64") !== secret || decoded.every((byte) => byte === 0)) return void 0;
	return { atRestSecretKey: secret };
}
/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
function deriveProtectorKey(secret) {
	return createHash("sha256").update(secret, "utf8").digest();
}
/** The id envelopes name for a key: sha256(key) hex, first 16 chars. */
function keyIdOf(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
/** The key helper cannot be reached: no binary, spawn failure, or unusable payload. */
var KeyUnavailableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "KeyUnavailableError";
	}
};
function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** The Electron binary to spawn, or a diagnosable KeyUnavailableError. Env override first; no path guessing. */
function resolveElectronPath(env = process.env, platform = process.platform) {
	const configured = env[WORKBUDDY_ELECTRON_BIN_ENV];
	if (configured !== void 0 && configured !== "") {
		if (!isExecutable(configured)) throw new KeyUnavailableError(`WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：${configured}`);
		return configured;
	}
	const platformDefault = platform === "darwin" ? MACOS_ELECTRON_PATH : void 0;
	if (platformDefault === void 0) throw new KeyUnavailableError("此平台没有默认的 WorkBuddy Electron 路径；请用 WORKBUDDY_ELECTRON_BIN 指定其 Electron 二进制");
	if (!isExecutable(platformDefault)) throw new KeyUnavailableError("未找到 WorkBuddy 的 Electron 二进制（默认路径不可用，可能 App 装在别处）；可用 WORKBUDDY_ELECTRON_BIN 指定");
	return platformDefault;
}
const HELPER_SCRIPT = "process.stdout.write(String(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet()))";
function spawnPayload(electronPath, timeoutMs = 1e4) {
	return new Promise((resolve, reject) => {
		execFile(electronPath, ["-e", HELPER_SCRIPT], {
			timeout: timeoutMs,
			maxBuffer: 1048576,
			windowsHide: true,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			}
		}, (error, stdout) => {
			if (error !== null && error !== void 0) {
				reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} ${error.killed === true ? `超时 ${timeoutMs}ms` : error.code !== void 0 ? `退出码 ${error.code}` : "无法启动"}）`));
				return;
			}
			const output = stdout.trim();
			if (output === "") {
				reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} 无输出）`));
				return;
			}
			resolve(output);
		});
	});
}
/** The real source: resolve the binary on this machine, spawn it once, take its payload. */
function defaultKeySource() {
	return spawnPayload(resolveElectronPath());
}
let cachedDefault;
let inflightDefault;
/**
* The machine's current protector key. Deliberately does NOT enforce that
* envelope key ids match — matching each envelope is the caller's job, so a
* backup sealed by a previous install can be skipped without failing here.
*/
async function protectorKey(source) {
	if (source === void 0) {
		if (cachedDefault !== void 0) return cachedDefault;
		inflightDefault ??= (async () => {
			const payload = parseAtRestPayload(await defaultKeySource());
			if (payload === void 0) throw new KeyUnavailableError("获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）");
			const key = deriveProtectorKey(payload.atRestSecretKey);
			return {
				key,
				keyId: keyIdOf(key)
			};
		})().finally(() => {
			inflightDefault = void 0;
		}).then((resolved) => {
			cachedDefault = resolved;
			return resolved;
		});
		return inflightDefault;
	}
	const payload = parseAtRestPayload(await source());
	if (payload === void 0) throw new KeyUnavailableError("获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）");
	const key = deriveProtectorKey(payload.atRestSecretKey);
	return {
		key,
		keyId: keyIdOf(key)
	};
}
//#endregion
//#region src/checkin.ts
/** Windows prefers Local, with Roaming for older desktop versions. */
function authDirsFor(platform = process.platform, env = process.env, home = homedir()) {
	const bases = platform === "win32" ? [env.LOCALAPPDATA || join(home, "AppData", "Local"), env.APPDATA || join(home, "AppData", "Roaming")] : [platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config")];
	return [...new Set(bases.map((base) => join(base, "CodeBuddyExtension", "Data", "Public", "auth")))];
}
const statePath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".buddy-checkin.json");
/** Pre-rename state file, read as a fallback so upgrading keeps today's results (next save writes the new path). */
const legacyStatePath = (path) => path.endsWith(".buddy-checkin.json") ? path.replace(/\.buddy-checkin\.json$/u, ".workbuddy-checkin.json") : void 0;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(/* @__PURE__ */ new Date());
function string(v) {
	return typeof v === "string" && v !== "" ? v : void 0;
}
function candidate(name, raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const d = raw;
	const a = d.account;
	const auth = d.auth;
	const uid = string(a?.uid);
	const domain = string(auth?.domain) ?? string((a?.domain)?.domain);
	if (!uid || !domain) return void 0;
	const token = string(auth?.accessToken);
	const tokenEnvelope = token === void 0 ? parseEnvelope(auth?.accessToken) : void 0;
	const nickname = string(a?.nickname);
	const nicknameEnvelope = nickname === void 0 ? parseEnvelope(a?.nickname) : void 0;
	return {
		name,
		uid,
		domain,
		...token === void 0 ? {} : { token },
		...tokenEnvelope === void 0 ? {} : { tokenEnvelope },
		...nickname === void 0 ? {} : { nickname },
		...nicknameEnvelope === void 0 ? {} : { nicknameEnvelope }
	};
}
/** Best credential for one uid: newest file first, skipping encrypted backups this machine's key cannot open. */
function resolveUid(files, key, keyError) {
	for (const f of files) {
		if (f.token !== void 0) return { credential: {
			uid: f.uid,
			domain: f.domain,
			accessToken: f.token,
			...f.nickname === void 0 ? {} : { nickname: f.nickname }
		} };
		if (f.tokenEnvelope !== void 0 && key !== void 0 && key.keyId === f.tokenEnvelope.keyId) {
			const token = openAuthField(key.key, f.tokenEnvelope);
			if (token === void 0) continue;
			const nickname = f.nicknameEnvelope === void 0 ? void 0 : openAuthField(key.key, f.nicknameEnvelope);
			return { credential: {
				uid: f.uid,
				domain: f.domain,
				accessToken: token,
				...nickname === void 0 || nickname === "" ? {} : { nickname }
			} };
		}
	}
	const encrypted = files.some((f) => f.tokenEnvelope !== void 0);
	return { reason: encrypted && keyError !== void 0 ? `凭据已加密，${keyError}` : encrypted ? "凭据由旧密钥加密，当前 WorkBuddy 无法解开（可能为重装 App 前的备份）；在 WorkBuddy App 重新登录该账号可恢复" : "凭据文件格式无法识别；在 WorkBuddy App 重新登录该账号可恢复" };
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
async function discover(dirs = authDirsFor(), opts = {}) {
	let accumulated = [];
	for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
		const files = await readdir(dir).catch(() => []);
		const groups = /* @__PURE__ */ new Map();
		for (const name of files) {
			if (!(name === "workbuddy-desktop.info" || /^workbuddy-desktop\.\d{4}-/u.test(name))) continue;
			let raw = null;
			try {
				raw = JSON.parse(await readFile(join(dir, name), "utf8"));
			} catch {}
			const c = candidate(name, raw);
			if (c === void 0) continue;
			const list = groups.get(c.uid) ?? [];
			list.push(c);
			groups.set(c.uid, list);
		}
		if (groups.size === 0) continue;
		for (const list of groups.values()) list.sort((x, y) => y.name < x.name ? -1 : y.name > x.name ? 1 : 0);
		let key;
		let keyError;
		if ([...groups.values()].some((list) => list.some((c) => c.tokenEnvelope !== void 0))) try {
			key = await protectorKey(opts.keySource);
		} catch (e) {
			keyError = e instanceof Error ? e.message : String(e);
		}
		const credentials = [];
		const unreadable = [];
		for (const [uid, list] of groups) {
			const resolved = resolveUid(list, key, keyError);
			if (resolved.credential !== void 0) credentials.push(resolved.credential);
			else unreadable.push({
				uid,
				reason: resolved.reason ?? "凭据无法读取"
			});
		}
		if (credentials.length > 0) {
			const rescued = new Set(credentials.map((c) => c.uid));
			return {
				credentials,
				unreadable: [...accumulated, ...unreadable].filter((u) => !rescued.has(u.uid))
			};
		}
		accumulated = [...accumulated, ...unreadable];
	}
	return {
		credentials: [],
		unreadable: accumulated
	};
}
function headers(c) {
	return {
		"content-type": "application/json",
		"authorization": `Bearer ${c.accessToken}`,
		"x-user-id": c.uid,
		"x-domain": c.domain,
		...c.enterpriseId ? {
			"x-enterprise-id": c.enterpriseId,
			"x-tenant-id": c.enterpriseId
		} : {}
	};
}
async function balance(c) {
	const r = await fetch(`https://${c.domain}/v2/billing/meter/get-user-resource`, {
		method: "POST",
		headers: headers(c),
		signal: AbortSignal.timeout(15e3),
		body: JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: "p_tcaca",
			Status: [0, 3]
		})
	});
	const b = await r.json();
	const a = b?.data?.Response?.Data?.Accounts;
	return r.ok && (b?.code === void 0 || b.code === 0) && Array.isArray(a) ? a.reduce((n, x) => n + (typeof x?.CycleCapacityRemain === "number" ? x.CycleCapacityRemain : 0), 0) : void 0;
}
async function check(c, now = /* @__PURE__ */ new Date()) {
	const at = now.toISOString();
	try {
		const r = await fetch(`https://${c.domain}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: headers(c),
			body: "{}"
		});
		const b = await r.json();
		const already = string(b?.msg)?.includes("已签到") === true;
		if (!r.ok && !already) throw new Error(String(b?.msg ?? `HTTP ${r.status}`));
		const total = await balance(c).catch(() => void 0);
		return {
			uid: c.uid,
			...c.nickname ? { nickname: c.nickname } : {},
			state: already ? "already" : "signed",
			at,
			...!already && typeof b?.data?.credit === "number" ? { credit: b.data.credit } : {},
			...total === void 0 ? {} : { balance: total }
		};
	} catch (e) {
		return {
			uid: c.uid,
			...c.nickname ? { nickname: c.nickname } : {},
			state: "failed",
			at,
			error: e instanceof Error ? e.message : String(e)
		};
	}
}
function savedDocument(parsed) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const d = parsed;
	if (typeof d.day !== "string" || typeof d.checkedAt !== "string" || !Array.isArray(d.results)) return void 0;
	return d;
}
async function load(path = statePath()) {
	try {
		return savedDocument(JSON.parse(await readFile(path, "utf8")));
	} catch {}
	const legacy = legacyStatePath(path);
	if (legacy === void 0) return void 0;
	try {
		return savedDocument(JSON.parse(await readFile(legacy, "utf8")));
	} catch {
		return;
	}
}
async function save(saved, path = statePath()) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, JSON.stringify(saved), { mode: 384 });
	await rename(temporary, path);
	return saved;
}
/** Refresh balances without repeating the daily check-in. */
async function refreshBalances(path = statePath(), accounts, opts = {}) {
	const previous = await load(path);
	if (!previous) return void 0;
	let discovered;
	let unreadableByUid = /* @__PURE__ */ new Map();
	if (accounts === void 0) {
		const d = await discover(authDirsFor(), opts);
		discovered = d.credentials;
		unreadableByUid = new Map(d.unreadable.map((u) => [u.uid, u.reason]));
	} else discovered = accounts;
	const accountByUid = new Map(discovered.map((account) => [account.uid, account]));
	const results = await Promise.all(previous.results.map(async (result) => {
		const account = accountByUid.get(result.uid);
		if (account === void 0) return {
			...result,
			balanceError: unreadableByUid.get(result.uid) ?? "未找到登录凭据，显示上次记录"
		};
		const total = await balance(account).catch(() => void 0);
		return total === void 0 ? {
			...result,
			balanceError: "余额查询失败，显示上次记录"
		} : {
			...result,
			balance: total,
			balanceCheckedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}));
	const latest = await load(path);
	if (!latest || latest.day !== previous.day) return latest;
	const observations = new Map(results.map((result) => [result.uid, result]));
	return {
		...latest,
		results: latest.results.map((result) => {
			const observed = observations.get(result.uid);
			if (!observed) return result;
			return {
				...result,
				...observed.balance === void 0 ? {} : { balance: observed.balance },
				...observed.balanceCheckedAt ? { balanceCheckedAt: observed.balanceCheckedAt } : {},
				...observed.balanceError ? { balanceError: observed.balanceError } : {}
			};
		})
	};
}
async function run(path = statePath(), opts = {}) {
	const previous = await load(path);
	const day = today();
	const sameDay = previous?.day === day;
	const prior = sameDay ? previous.results : [];
	const completed = new Map(prior.filter((x) => x.state !== "failed").map((x) => [x.uid, x]));
	const { credentials, unreadable } = await discover(authDirsFor(), opts);
	const attempted = await Promise.all(credentials.filter((c) => !completed.has(c.uid)).map((c) => check(c)));
	const blocked = unreadable.filter((u) => !completed.has(u.uid)).map((u) => ({
		uid: u.uid,
		state: "failed",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		error: u.reason
	}));
	const tried = [...attempted, ...blocked];
	const results = credentials.map((c) => completed.get(c.uid)).filter((x) => x !== void 0).concat(tried);
	const ok = tried.filter((x) => x.state !== "failed").length;
	return save({
		day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...sameDay && previous?.balanceCheckedAt ? { balanceCheckedAt: previous.balanceCheckedAt } : {},
		...tried.length === 0 ? {} : { notice: tried.some((x) => x.state === "failed") ? `WorkBuddy 签到 ${ok}/${tried.length} 成功，失败账号可在面板中重试` : `WorkBuddy 已完成今日签到：${ok} 个账号` }
	}, path);
}
/** The panel only retries accounts that failed in today's startup attempt. */
async function retryFailed(path = statePath(), opts = {}) {
	const previous = await load(path);
	if (!previous || previous.day !== today()) return run(path, opts);
	const { credentials, unreadable } = await discover(authDirsFor(), opts);
	const accountByUid = new Map(credentials.map((account) => [account.uid, account]));
	const retried = await Promise.all(previous.results.filter((result) => result.state === "failed").flatMap((result) => {
		const account = accountByUid.get(result.uid);
		return account === void 0 ? [] : [check(account)];
	}));
	const replacements = new Map(retried.map((result) => [result.uid, result]));
	const unreadableByUid = new Map(unreadable.map((u) => [u.uid, u.reason]));
	const priorByUid = new Map(previous.results.map((result) => [result.uid, result]));
	const results = [.../* @__PURE__ */ new Set([...accountByUid.keys(), ...priorByUid.keys()])].map((uid) => {
		const prior = priorByUid.get(uid);
		if (prior !== void 0 && prior.state !== "failed") return prior;
		const replacement = replacements.get(uid);
		if (replacement !== void 0) return replacement;
		if (accountByUid.has(uid)) return prior;
		const reason = unreadableByUid.get(uid);
		return reason === void 0 ? prior : {
			uid,
			state: "failed",
			at: (/* @__PURE__ */ new Date()).toISOString(),
			error: reason
		};
	}).filter((x) => x !== void 0);
	return save({
		day: previous.day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...previous.balanceCheckedAt ? { balanceCheckedAt: previous.balanceCheckedAt } : {}
	}, path);
}
const status = (s) => s.results.length === 0 ? "none" : s.results.every((x) => x.state !== "failed") ? "ok" : s.results.some((x) => x.state !== "failed") ? "warn" : "error";
//#endregion
//#region src/index.ts
const name = "dsh-buddy-checkin";
const inject = ["webServer", "clientModules"];
const local = (value) => value === "localhost" || value?.startsWith("localhost:") === true || value === "127.0.0.1" || value?.startsWith("127.0.0.1:") === true || value === "[::1]" || value?.startsWith("[::1]:") === true;
function trusted(req) {
	if (!local(req.headers.host)) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return local(new URL(origin).host);
	} catch {
		return false;
	}
}
function respond(res, saved) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(saved ? {
		...saved,
		status: status(saved)
	} : {
		status: "none",
		results: []
	}));
}
function apply(ctx) {
	const modules = ctx.clientModules;
	ctx.logger.info(`client graph includes check-in: ${modules.graph().entries.some((entry) => entry.id === "dsh-buddy-checkin")}`);
	const startup = run().catch((error) => {
		ctx.logger.warn(error);
	});
	ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => {
		const disposeStatus = webCtx.webServer.register({
			kind: "exact",
			path: "/buddy-checkin/status",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method === "GET") {
					await startup;
					respond(res, await load());
					return;
				}
				if (req.method === "POST") {
					await startup;
					respond(res, await retryFailed());
					return;
				}
				res.writeHead(405, { allow: "GET, POST" });
				res.end();
			}
		});
		const disposeBalance = webCtx.webServer.register({
			kind: "exact",
			path: "/buddy-checkin/refresh-balance",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method === "POST") {
					await startup;
					respond(res, await refreshBalances());
					return;
				}
				res.writeHead(405, { allow: "POST" });
				res.end();
			}
		});
		return () => {
			disposeStatus();
			disposeBalance();
		};
	}, "dsh-buddy-checkin: status"));
}
//#endregion
export { apply, inject, name };
