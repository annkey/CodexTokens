# Codex Token 统计工具

一个本地运行的 Codex token 仪表盘，自动读取 `~/.codex` 下的 SQLite 日志，展示：

- 每天、每周、每月 token 用量趋势
- 今日 / 本周 / 本月 / 累计统计
- input / output / cached / reasoning / tool token 构成
- 累计用量最高的线程排行

## 启动

```powershell
npm start
```

默认地址：

```text
http://localhost:3210
```

## 可选环境变量

- `PORT`：自定义端口
- `CODEX_HOME`：自定义 Codex 数据目录，默认读取 `C:\Users\<用户名>\.codex`

示例：

```powershell
$env:PORT=4000
$env:CODEX_HOME='C:\Users\35896\.codex'
npm start
```

## 数据来源

- `logs_1.sqlite`：解析 `response.completed` 日志，作为日 / 周 / 月统计主数据源
- `state_5.sqlite`：读取线程累计 `tokens_used`，用于线程排行展示

## 说明

图表总量按以下字段求和：

- `input_token_count`
- `output_token_count`
- `cached_token_count`
- `reasoning_token_count`
- `tool_token_count`

如果你的 Codex 数据目录结构不同，可以通过 `CODEX_HOME` 指向新的路径。
