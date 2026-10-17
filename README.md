# navigation-web

个人导航起始页：Warframe PE 主题（Windows PE 风格界面）、多引擎搜索、书签/快链、Warframe 世界状态（官方 worldstate 校时 + 赏金/钢路/鸟三/回廊/仲裁）、WF Market 实时行情、界面自定义。

## 使用

直接打开 index.html 即可用搜索、联想和书签；实时价格需要先启动本地代理（`api.warframe.market` 只给 warframe.market 自家 Origin 发 CORS 头）：

```powershell
node wf-market-proxy.mjs
# 或双击 start-wf-market.cmd
# 打开 http://127.0.0.1:8898/
```

代理同时托管导航页，并转发 Warframe Market 挂单与官方 worldstate（`/api/wf/worldstate`）。Warframe 面板优先使用官方 worldstate；代理未启动时自动回退到本地精确推算（希图斯/赏金用官方锚点，瓦利斯/扎里曼/双衍/钢路/鸟三/回廊用 WFCD 校准公式）。仲裁推荐首次打开时按需加载 `wf-arbitration.js`，不阻塞首屏。

## GitHub Pages

仓库 Settings → Pages → Deploy from branch main / root。

## Cloudflare Workers 免费部署（可选）

不想在本机跑代理时，可以用 Cloudflare Worker 免费版同时托管页面和价格接口：

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**。
2. 名字随意（如 `warframe-pe`），点 **Deploy**。
3. 点 **Edit code**，把 [`cloudflare-worker.mjs`](cloudflare-worker.mjs) 整个粘贴进去，再点 **Deploy**。
4. 打开 `https://<名字>.<你的子域>.workers.dev/`，页面、Market 价格、世界状态都由 Worker 提供。

Worker 会从本仓库 `main` 分支的 GitHub raw 读取静态文件，并代理 `/api/wf/orders` 与 `/api/wf/worldstate`。免费版额度是 100,000 请求/天、单次 10ms CPU，个人使用足够；接口结果缓存 25–30 秒。

注意：`*.workers.dev` 在中国大陆可能无法直接访问，能访问时再用；需要长期使用可以给 Worker 绑定自定义域名。如果 fork 了仓库，记得改 `cloudflare-worker.mjs` 顶部的 `REPO` / `BRANCH`。
