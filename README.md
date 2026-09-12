# dsh-workbuddy-checkin（孵化中）

WorkBuddy 国内版每日签到的独立 DSH 插件。DSH 启动时扫描本机登录过的全部国内版账号，并为当天尚未签到的账号自动完成签到；不读取国际版账号。

命名说明：checkin 与上游端点拼写一致（`/v2/billing/meter/daily-checkin`）；不用 signin（英文语境第一联想是登录）。

状态：**调研与 v1 交互已定，未开工**。接口契约、账号发现与交互规格见 [`docs/checkin-research-2026-09-12.md`](./docs/checkin-research-2026-09-12.md)。

与 [dsh-workbuddy-connect](../dsh-workbuddy-connect)（模型接入）互不依赖，按 issue #18 的诉求独立成插件。
