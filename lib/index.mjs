import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/checkin.ts
/** The shared login store WorkBuddy's desktop app writes: Application Support on macOS, %LOCALAPPDATA% on Windows. */
const authDirFor = (platform = process.platform, env = process.env, home = homedir()) => platform === "win32" ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "CodeBuddyExtension", "Data", "Public", "auth") : join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth");
const authDir = () => authDirFor();
const statePath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".buddy-checkin.json");
/** Pre-rename state file, read as a fallback so upgrading keeps today's results (next save writes the new path). */
const legacyStatePath = (path) => path.endsWith(".buddy-checkin.json") ? path.replace(/\.buddy-checkin\.json$/u, ".workbuddy-checkin.json") : void 0;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(/* @__PURE__ */ new Date());
function string(v) {
	return typeof v === "string" && v !== "" ? v : void 0;
}
function credential(raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const d = raw;
	const a = d.account;
	const auth = d.auth;
	const uid = string(a?.uid);
	const accessToken = string(auth?.accessToken);
	const domain = string(auth?.domain) ?? string((a?.domain)?.domain);
	const nickname = string(a?.nickname);
	return uid && accessToken && domain ? {
		uid,
		accessToken,
		domain,
		...nickname === void 0 ? {} : { nickname }
	} : void 0;
}
async function discover(dir = authDir()) {
	const files = await readdir(dir).catch(() => []);
	const latest = /* @__PURE__ */ new Map();
	for (const name of files) {
		if (!(name === "workbuddy-desktop.info" || /^workbuddy-desktop\.\d{4}-/u.test(name))) continue;
		let raw = null;
		try {
			raw = JSON.parse(await readFile(join(dir, name), "utf8"));
		} catch {}
		const c = credential(raw);
		if (c && (latest.get(c.uid)?.name ?? "") < name) latest.set(c.uid, {
			c,
			name
		});
	}
	return [...latest.values()].map((x) => x.c);
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
async function refreshBalances(path = statePath(), accounts) {
	const previous = await load(path);
	if (!previous) return void 0;
	const discovered = accounts ?? await discover();
	const accountByUid = new Map(discovered.map((account) => [account.uid, account]));
	const results = await Promise.all(previous.results.map(async (result) => {
		const account = accountByUid.get(result.uid);
		if (account === void 0) return {
			...result,
			balanceError: "未找到登录凭据，显示上次记录"
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
async function run(path = statePath()) {
	const previous = await load(path);
	const day = today();
	const sameDay = previous?.day === day;
	const prior = sameDay ? previous.results : [];
	const completed = new Map(prior.filter((x) => x.state !== "failed").map((x) => [x.uid, x]));
	const accounts = await discover();
	const attempted = await Promise.all(accounts.filter((c) => !completed.has(c.uid)).map((c) => check(c)));
	const results = accounts.map((c) => completed.get(c.uid)).filter((x) => x !== void 0).concat(attempted);
	const ok = attempted.filter((x) => x.state !== "failed").length;
	return save({
		day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...sameDay && previous?.balanceCheckedAt ? { balanceCheckedAt: previous.balanceCheckedAt } : {},
		...attempted.length === 0 ? {} : { notice: attempted.some((x) => x.state === "failed") ? `WorkBuddy 签到 ${ok}/${attempted.length} 成功，失败账号可在面板中重试` : `WorkBuddy 已完成今日签到：${ok} 个账号` }
	}, path);
}
/** The panel only retries accounts that failed in today's startup attempt. */
async function retryFailed(path = statePath()) {
	const previous = await load(path);
	if (!previous || previous.day !== today()) return run(path);
	const accounts = await discover();
	const accountByUid = new Map(accounts.map((account) => [account.uid, account]));
	const retried = await Promise.all(previous.results.filter((result) => result.state === "failed").flatMap((result) => {
		const account = accountByUid.get(result.uid);
		return account === void 0 ? [] : [check(account)];
	}));
	const replacements = new Map(retried.map((result) => [result.uid, result]));
	const results = accounts.flatMap((account) => {
		const result = replacements.get(account.uid) ?? previous.results.find((item) => item.uid === account.uid);
		return result === void 0 ? [] : [result];
	});
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
