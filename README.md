# 采策 · 智能采购助手

这个仓库用于在 Render 上部署采策网页。采购分析由已发布的 Dify Chatflow 执行，延期补货测算沿用断供重优化的剩余产能与预算。访客可用采购请求编号运行分析，数据由工作流自动读取。

## 功能升级版

1. 在「断供模拟」指定供应商和断供比例。报告对比断供前与重优化后的成本优先、风险优先方案，展示覆盖量、缺口、满足率、支出、风险和集中度（HHI），并给出采购建议。可下载 Markdown 决策报告。
2. 如果重优化仍有缺口，从报告点击「测算延期能否补齐」。选择方案后，比较 0、3、5、7、10 天和自定义延期的可补量、剩余缺口及增量成本，查看能补齐的最早日期和对应报价。
3. 如需评估替代料，在「缺口恢复」引用断供结果或直接填写缺口与预算。供应商风险与采购优化仍可独立运行。

## 部署到 Render

如果已经创建 Web Service 并配置 Dify 密钥，在该服务中连接本仓库，选 main 分支，并使用以下设置。

| 设置 | 值 |
| --- | --- |
| Runtime | Node |
| Build Command | npm ci |
| Start Command | npm start |
| Health Check Path | /api/status |
| Environment | 已配置的 DIFY_API_KEY |

Render 会提供 PORT 和 RENDER_EXTERNAL_URL。使用自定义域名时可把 PUBLIC_ORIGIN 设置为该域名的 HTTPS 源，例如 https://procure.example.com。

首次部署也可以从 Render 的 Blueprint 入口连接本仓库。仓库里的 render.yaml 会创建 Node Web Service 并提示填写 DIFY_API_KEY。已经有服务时可以直接使用上表配置，继续用原服务的环境变量。

将压缩包解开后，把源码文件放在 Render 所连 GitHub 仓库的根目录。`DIFY_API_KEY` 应使用已发布的五功能 Chatflow 的应用密钥。报告与延期测算读取该 Chatflow 的断供、采购重优化和韧性节点输出。如果另建了 Chatflow 或重新创建过这些节点，需先核对 `lib/procurement.mjs` 的节点 ID 和变量名。

部署完成后打开 Render 生成的网址。用 REQ-001 运行一次「供应商风险」。想演示完整断供链路时，选择「断供模拟」，填入供应商 COM-023、断供比例 1，然后在报告中选择「测算延期能否补齐」。

## 本机运行

需要 Node.js 22.13 或更高版本。运行 npm run dev 后打开 http://127.0.0.1:4173/。本机可复制 .env.example 为 .env.local，然后在文件中填写密钥。留空时本机使用演示数据。

[Render Web Services](https://render.com/docs/web-services) · [Render 环境变量](https://render.com/docs/configure-environment-variables)

