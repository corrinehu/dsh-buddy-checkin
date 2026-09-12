window.__ModuleLoader__.load({
	id: "dsh-workbuddy-checkin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		const icon = "data:image/png;base64,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";
		const name = "dsh-workbuddy-checkin-client";
		const inject = ["slots"];
		const color = {
			ok: "#22c55e",
			warn: "#eab308",
			error: "#ef4444",
			none: "#64748b"
		};
		function App() {
			const [data, setData] = (0, react.useState)();
			const [open, setOpen] = (0, react.useState)(false);
			const [toast, setToast] = (0, react.useState)();
			(0, react.useEffect)(() => {
				fetch("/workbuddy-checkin/status").then((r) => {
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
			(0, react.useEffect)(() => {
				if (!toast) return;
				const id = window.setTimeout(() => setToast(void 0), 6e3);
				return () => window.clearTimeout(id);
			}, [toast]);
			if (!data || data.status === "none" || !Array.isArray(data.results)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				toast && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						position: "fixed",
						zIndex: 1001,
						right: 24,
						top: 20,
						padding: "10px 14px",
						borderRadius: 9,
						background: "#292929",
						border: `1px solid ${color[data.status]}`,
						color: "#eee",
						boxShadow: "0 8px 24px #0008",
						fontSize: 14
					},
					children: toast
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					onClick: () => setOpen(true),
					title: "WorkBuddy 签到",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						border: 0,
						background: "transparent",
						color: "inherit",
						fontSize: 16,
						cursor: "pointer"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							src: icon,
							style: {
								width: 19,
								height: 19,
								borderRadius: 4
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							"(",
							data.results.length,
							")"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: {
							width: 8,
							height: 8,
							borderRadius: "50%",
							background: color[data.status]
						} })
					]
				}),
				open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						position: "fixed",
						zIndex: 1e3,
						width: 340,
						right: 24,
						top: 82,
						background: "#252525",
						border: "1px solid #4a4a4a",
						borderRadius: 12,
						padding: 16,
						boxShadow: "0 18px 45px #0008",
						color: "#f4f4f5"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							onClick: () => setOpen(false),
							style: {
								float: "right",
								background: "transparent",
								border: 0,
								color: "#bbb",
								fontSize: 20,
								cursor: "pointer"
							},
							children: "×"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("b", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								fontSize: 18
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								src: icon,
								style: {
									width: 24,
									height: 24,
									borderRadius: 5
								}
							}), "WorkBuddy 签到"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: {
								color: "#aaa",
								fontSize: 13
							},
							children: ["本次启动检查：", data.checkedAt ? new Date(data.checkedAt).toLocaleString() : "—"]
						}),
						data.results.map((x) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: "10px 0",
								borderTop: "1px solid #444"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: x.nickname ?? x.uid }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 13,
										color: x.state === "failed" ? "#f87171" : "#bdbdbd",
										marginTop: 4
									},
									children: x.state === "signed" ? `已签到 · ${new Date(x.at).toLocaleTimeString()}${x.credit === void 0 ? "" : ` · +${x.credit} 积分`}` : x.state === "already" ? "App 内今日已签到" : `签到失败：${x.error}`
								}),
								x.balance === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 13,
										color: "#bdbdbd",
										marginTop: 3
									},
									children: ["剩余积分：", x.balance.toLocaleString()]
								})
							]
						}, x.uid))
					]
				})
			] });
		}
		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "workbuddy-checkin-header",
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
