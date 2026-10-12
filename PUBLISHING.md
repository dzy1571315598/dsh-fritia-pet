# 用 GitHub MCP 把这个桌宠开源到 GitHub

本机环境实测结论（决定了下面为什么这样做）：

| 事实 | 影响 |
|---|---|
| 没有装 `git`，也没有 `gh` 与 Docker | 不能靠 `git push`；仓库创建、提交、上传全部走 **GitHub API（MCP / REST）** |
| `registry.npmjs.org` 可达 | 可以用 `npx` 拉起 npm 上的 GitHub MCP server |
| `github.com` 与 releases 下载**不可达** | 用不了官方 Go 版 `github-mcp-server.exe`，只能用 npm 包 |
| Windows 上 Node 无法直接 spawn `.cmd`/`.bat`（`spawn('npx.cmd')` → `EINVAL`） | MCP 行**不能**直接写 `command: npx`，需要一个 Node 启动器 |

## 一、准备 token

在 <https://github.com/settings/personal-access-tokens> 建一个 **fine-grained PAT**，权限：

- **Contents: Read and write** —— 建文件 / 提交
- **Administration: Read and write** —— 创建仓库
- **Metadata: Read-only** —— GitHub 强制要求
- （可选）Issues、Pull requests: Read and write

然后把 token 写进 `mcp/token.txt`（该文件已被 `.gitignore` 忽略）：

```powershell
Copy-Item D:\DeepseekHarness\FritiaPlugin\mcp\token.txt.example `
          D:\DeepseekHarness\FritiaPlugin\mcp\token.txt
notepad D:\DeepseekHarness\FritiaPlugin\mcp\token.txt   # 粘贴 token，保存
```

也可以改成用环境变量：启动 DSH 前设置 `GITHUB_TOKEN`。

## 二、把 MCP server 挂进 DSH

`mcp/bundle/` 已经写好一个"只做配置"的 bundle：

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: node
        args: ['D:/DeepseekHarness/FritiaPlugin/mcp/github-mcp.mjs']
```

`mcp/github-mcp.mjs` 负责解析 token 并用 `npx -y @modelcontextprotocol/server-github@latest`
拉起真正的 MCP server，stdio 直通。安装：

```
plugin_manager install_bundle  target = D:\DeepseekHarness\FritiaPlugin\mcp\bundle
```

安装后**重启一次 DSH**，工具才会出现在模型工具表里（名字形如 `mcp__github__create_repository`）。

> 说明：在拿到 token 之前不要装这个 bundle —— `failOnStartupError: true`，没有 token 时
> 该行会激活失败并提示 `initial connection or tool synchronization failed`（这是预期行为，
> 说明配置已生效，只缺凭据）。想先装后给 token，把它改成 `false` 即可。

## 三、验证 MCP 真的通了

不依赖 DSH、独立验证一次握手：

```powershell
$env:GITHUB_TOKEN = "<你的 token>"
node D:\DeepseekHarness\FritiaPlugin\mcp\verify-mcp.mjs
```

预期输出（本机实测结果）：

```
server info   : {"name":"github-mcp-server","version":"0.6.2"}
protocol      : 2024-11-05
capabilities  : ["tools"]
tools offered : 26
needed for the publish flow: all present
```

## 四、发布流程（拿到 token 后我可以直接执行）

1. `mcp__github__get_me` —— 确认 token、拿到你的用户名。
2. `mcp__github__create_repository` —— 建 `dsh-fritia-pet`，公开，带描述与 MIT。
3. `mcp__github__create_or_update_file` —— 先提交文本文件（可读的第一版）：
   `package.json`、`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`.gitignore`
4. `mcp__github__create_or_update_file` —— 再提交 20 张立绘（`sprites/*.png`，base64），
   按文件逐个提交到同一个分支。约 1.7 MB，用 `toolCallTimeoutMs: 120000` 留足时间。
5. `mcp__github__create_issue` / `create_pull_request` / `list_commits` —— 之后的日常维护。

推送前需要确认的元数据：把 `package.json` 里的 `<your-name>` 换成你的 GitHub 用户名
（`repository` / `homepage` / `bugs` 三处）。

## 五、还想更顺手？

装一个 `git`（`winget install --id Git.Git`）之后就有了标准工作流：
`git init` → `git add -A` → `git commit` → `git push`（首次推送时用 PAT 作为密码）。
GitHub MCP 依然有用：建仓库、开 issue、审 PR 不用切浏览器。
