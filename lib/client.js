window.__ModuleLoader__.load({
	id: "dsh-buddy-checkin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.tsx
		const { useEffect, useState } = react;
		const name = "dsh-buddy-checkin-client";
		const inject = ["slots"];
		const icon = "data:image/png;base64,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";
		const color = {
			ok: "var(--dsw-alias-state-success-primary,#22c55e)",
			warn: "var(--dsw-alias-state-warn-primary,#eab308)",
			error: "var(--dsw-alias-state-error-primary,#ef4444)",
			none: "var(--dsw-alias-label-dimmed,#64748b)"
		};
		const bgLayer = "var(--dsw-alias-bg-layer-1,#252525)";
		const borderL2 = "var(--dsw-alias-border-l2,#4a4a4a)";
		const labelPrimary = "var(--dsw-alias-label-primary,#f4f4f5)";
		const labelSecondary = "var(--dsw-alias-label-secondary,#bdbdbd)";
		const outcome = (row) => row.state === "signed" ? `已签到 ${new Date(row.at).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit"
		})}${row.credit === void 0 ? "" : ` · +${row.credit} 积分`}` : row.state === "already" ? "App 内今日已签到" : `失败：${row.error ?? "请稍后重试"}`;
		function App() {
			const [data, setData] = useState();
			const [open, setOpen] = useState(false);
			const [toast, setToast] = useState();
			const [retrying, setRetrying] = useState(false);
			useEffect(() => {
				fetch("/buddy-checkin/status").then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return r.json();
				}).then((x) => {
					const d = x;
					if (!d || typeof d !== "object" || !Array.isArray(d.results)) throw new Error("unexpected status shape");
					setData(d);
					if (d.notice) setToast(d.notice);
				}).catch(() => setData({
					status: "error",
					results: []
				}));
			}, []);
			useEffect(() => {
				if (!toast) return;
				const id = window.setTimeout(() => setToast(void 0), 6e3);
				return () => window.clearTimeout(id);
			}, [toast]);
			const retry = async () => {
				setRetrying(true);
				try {
					const response = await fetch("/buddy-checkin/status", { method: "POST" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setData(await response.json());
				} finally {
					setRetrying(false);
				}
			};
			if (!data || data.status === "none" || !Array.isArray(data.results)) return null;
			const failed = data.results.some((row) => row.state === "failed");
			return /* @__PURE__ */ react.createElement(react.Fragment, null, toast && /* @__PURE__ */ react.createElement("div", { style: {
				position: "fixed",
				zIndex: 1001,
				right: 20,
				top: 18,
				padding: "8px 12px",
				borderRadius: 8,
				background: bgLayer,
				border: `1px solid ${color[data.status]}`,
				color: labelPrimary,
				boxShadow: "0 8px 24px #0008",
				fontSize: 13
			} }, toast), /* @__PURE__ */ react.createElement("button", {
				onClick: () => setOpen(true),
				title: "WorkBuddy 签到",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					border: 0,
					background: "transparent",
					color: "inherit",
					fontSize: 12,
					cursor: "pointer"
				}
			}, /* @__PURE__ */ react.createElement("img", {
				src: icon,
				alt: "WorkBuddy",
				className: "buddy-checkin-icon",
				style: {
					width: 16,
					height: 16
				}
			}), /* @__PURE__ */ react.createElement("span", null, "(", data.results.length, ")"), /* @__PURE__ */ react.createElement("i", { style: {
				width: 7,
				height: 7,
				borderRadius: "50%",
				background: color[data.status]
			} })), open && /* @__PURE__ */ react.createElement("div", { style: {
				position: "fixed",
				zIndex: 1e3,
				width: 310,
				right: 20,
				top: 72,
				background: bgLayer,
				border: `1px solid ${borderL2}`,
				borderRadius: 10,
				padding: 12,
				boxShadow: "0 18px 45px #0008",
				color: labelPrimary,
				fontSize: 13
			} }, /* @__PURE__ */ react.createElement("button", {
				onClick: () => setOpen(false),
				"aria-label": "关闭",
				style: {
					float: "right",
					background: "transparent",
					border: 0,
					color: labelSecondary,
					fontSize: 19,
					cursor: "pointer",
					lineHeight: 1
				}
			}, "×"), /* @__PURE__ */ react.createElement("b", { style: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				fontSize: 14
			} }, /* @__PURE__ */ react.createElement("img", {
				src: icon,
				className: "buddy-checkin-icon",
				style: {
					width: 16,
					height: 16
				}
			}), "WorkBuddy 签到"), /* @__PURE__ */ react.createElement("div", { style: {
				color: labelSecondary,
				fontSize: 12,
				margin: "7px 0"
			} }, "本次启动检查：", data.checkedAt ? new Date(data.checkedAt).toLocaleString() : "—"), /* @__PURE__ */ react.createElement("div", { style: {
				maxHeight: 120,
				overflowY: "auto"
			} }, data.results.map((row) => /* @__PURE__ */ react.createElement("div", {
				key: row.uid,
				style: {
					padding: "7px 0",
					borderTop: `1px solid ${borderL2}`
				}
			}, /* @__PURE__ */ react.createElement("div", { style: {
				display: "flex",
				gap: 6,
				alignItems: "baseline",
				minWidth: 0
			} }, /* @__PURE__ */ react.createElement("b", { style: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			} }, row.nickname ?? row.uid), /* @__PURE__ */ react.createElement("span", { style: {
				fontSize: 12,
				color: row.state === "failed" ? color.error : labelSecondary,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			} }, outcome(row))), /* @__PURE__ */ react.createElement("div", { style: {
				fontSize: 12,
				color: labelSecondary,
				marginTop: 3
			} }, row.balance === void 0 ? "积分：暂不可用" : `剩余积分：${row.balance.toLocaleString()}`)))), failed && /* @__PURE__ */ react.createElement("button", {
				disabled: retrying,
				onClick: () => void retry(),
				style: {
					marginTop: 8,
					width: "100%",
					padding: "6px 8px",
					borderRadius: 6,
					border: `1px solid ${borderL2}`,
					background: "transparent",
					color: "inherit",
					cursor: retrying ? "wait" : "pointer",
					fontSize: 13
				}
			}, retrying ? "正在重试…" : "重试失败账号")));
		}
		const iconFilterCss = ".buddy-checkin-icon{filter:invert(1)}body:not([data-ds-dark-theme]) .buddy-checkin-icon{filter:none}";
		function apply(ctx) {
			if (!document.getElementById("buddy-checkin-icon-filter")) {
				const style = document.createElement("style");
				style.id = "buddy-checkin-icon-filter";
				style.textContent = iconFilterCss;
				document.head.appendChild(style);
			}
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "buddy-checkin-header",
				order: 20
			}, App));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
