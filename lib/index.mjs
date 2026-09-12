import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/checkin.ts
const authDir = () => join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth");
const statePath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".workbuddy-checkin.json");
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
	const a = (await (await fetch(`https://${c.domain}/v2/billing/meter/get-user-resource`, {
		method: "POST",
		headers: headers(c),
		body: JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: "p_tcaca",
			Status: [0, 3]
		})
	})).json())?.data?.Response?.Data?.Accounts;
	return Array.isArray(a) ? a.reduce((n, x) => n + (typeof x?.CycleCapacityRemain === "number" ? x.CycleCapacityRemain : 0), 0) : void 0;
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
	} catch {
		return;
	}
}
async function run() {
	const previous = await load();
	const day = today();
	const prior = previous?.day === day ? previous.results : [];
	const completed = new Map(prior.filter((x) => x.state !== "failed").map((x) => [x.uid, x]));
	const accounts = await discover();
	const attempted = await Promise.all(accounts.filter((c) => !completed.has(c.uid)).map((c) => check(c)));
	const results = accounts.map((c) => completed.get(c.uid)).filter((x) => x !== void 0).concat(attempted);
	const ok = attempted.filter((x) => x.state !== "failed").length;
	const saved = {
		day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...attempted.length === 0 ? {} : { notice: attempted.some((x) => x.state === "failed") ? `WorkBuddy 签到 ${ok}/${attempted.length} 成功，失败账号将在下次启动重试` : `WorkBuddy 已完成今日签到：${ok} 个账号` }
	};
	await mkdir(dirname(statePath()), { recursive: true });
	const temporary = `${statePath()}.tmp`;
	await writeFile(temporary, JSON.stringify(saved), { mode: 384 });
	await rename(temporary, statePath());
	return saved;
}
const status = (s) => s.results.length === 0 ? "none" : s.results.every((x) => x.state !== "failed") ? "ok" : s.results.some((x) => x.state !== "failed") ? "warn" : "error";
//#endregion
//#region src/index.ts
const name = "dsh-workbuddy-checkin";
const inject = ["webServer"];
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
function apply(ctx) {
	run().catch((error) => ctx.logger.warn(error));
	ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => webCtx.webServer.register({
		kind: "exact",
		path: "/workbuddy-checkin/status",
		handler: async (req, res) => {
			if (req.method !== "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (!trusted(req)) {
				res.writeHead(403);
				res.end();
				return;
			}
			const saved = await load();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(saved ? {
				...saved,
				status: status(saved)
			} : {
				status: "none",
				results: []
			}));
		}
	}), "dsh-workbuddy-checkin: status"));
}
//#endregion
export { apply, inject, name };
