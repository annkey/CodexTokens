# Codex Token Dashboard

一个既支持本地读取 Codex SQLite，也支持外网展示的 token 统计面板。

## 两种运行模式

1. 本地模式
- 服务器直接读取 `~/.codex/logs_1.sqlite`
- 适合你在自己电脑上本地打开

2. 外网模式
- 服务器本身不读取本地 `.codex`
- 通过本地 `sync.js` 把聚合后的统计结果推送到线上
- 外网页面读取服务器保存的最新快照

## 启动服务

```powershell
npm start
```

默认地址：

```text
http://localhost:3210
```

## 本地同步到外网

在你自己的电脑上执行：

```powershell
$env:SYNC_TARGET_URL='https://你的域名/api/sync'
$env:SYNC_TOKEN='你设置的同步密钥'
npm run sync
```

如果你本地 Codex 数据目录不是默认路径，也可以指定：

```powershell
$env:CODEX_HOME='C:\Users\35896\.codex'
$env:SYNC_TARGET_URL='https://你的域名/api/sync'
$env:SYNC_TOKEN='你设置的同步密钥'
npm run sync
```

## 服务端环境变量

- `PORT`
- `CODEX_HOME`
- `SYNC_TOKEN`

说明：

- 当服务器能读到本地 `.codex` 时，优先使用本地 SQLite
- 当服务器读不到本地 `.codex` 时，会自动读取最近一次同步上来的快照
- 如果设置了 `SYNC_TOKEN`，调用 `/api/sync` 时必须带 `Authorization: Bearer <token>`

## 接口

- `GET /api/usage`
  - 获取当前展示数据
- `POST /api/sync`
  - 上传本地统计快照
- `GET /api/health`
  - 查看当前服务是否在本地模式或远程快照模式

## 部署建议

外网部署时推荐：

1. 在线上服务配置 `SYNC_TOKEN`
2. 本地电脑定时执行 `npm run sync`
3. 页面始终访问线上域名

这样外网页面就能展示你本机 Codex 的最新统计结果。
