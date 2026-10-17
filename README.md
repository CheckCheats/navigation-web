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
