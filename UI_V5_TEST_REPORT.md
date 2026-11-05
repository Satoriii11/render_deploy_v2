# V5 前端适配测试记录

## 版本与修改边界
- 基线：`caice_render_phase23_full_upgrade.zip`（上次交付的完整 Render 源码）。
- 本次仅改前端三文件：`public/desk/desk.js`、`public/desk/index.html`、`public/desk/style.css`。
- 后端 `lib/options.mjs`、`lib/procurement.mjs`、`lib/decision.mjs`、`lib/presentation.mjs` 及 Dify API 数据契约未变。
- 不修改 Dify 工作流，也不替换求解器。

## 已完成的本地检查
1. `node --check public/desk/desk.js`：PASS。
2. `node --check server.mjs`：PASS。
3. `node tests/smoke.mjs`：PASS，原五功能结构化呈现及延期业务模拟未回归。
4. Chromium 无网络测试（Playwright，注入模拟 API）：PASS。
   - 30条采购请求；公司名 `南京普天` 模糊搜索只匹配该模拟请求；产品 `贴片电阻` 搜索只匹配该请求；显示 `南京普天通信股份有限公司 · 贴片电阻10kΩ · 53700件`。
   - 选中后隐藏保存对应请求标识；切换至“采购优化”功能保持已选请求。
   - 45行模拟风险明细：表格可视高度355px，实际可滚动内容高2565px；表格内容宽1069px、视区宽662px；水平滑块点击后 `scrollLeft` 增至332px。
   - SVG 横向柱状图较长的完整原因字符串保留，无省略号。
   - 390px移动端下弹窗打开、搜索、关闭：PASS。
   - 断供模拟仍能显示供应商检索控件，并保留按请求筛选的接口逻辑。
5. 所有后端文件与基线对比一致，未改变任何采购业务计算规则。

## 未验证
- 不能访问用户线上 Render 服务和已发布的 Dify 实例；尚未线上联调。
- 53,700件采购需求在真实 Dify 求解时若报“组合数量过大”，是 Dify 采购优化枚举规模上限，**本次界面修复不会消除该求解限制**。模拟 API 仅用于界面验证，不代表优化方案已算出。

## 部署说明
解压 `caice_render_ui_v5_readable_tables_picker.zip` 后，把 `caice_ui_v5` 文件夹内的全部文件同步到连接 Render 的 GitHub 仓库根目录，再提交并推送。原环境变量及 Dify 工作流均无需更换。建议先保存可回滚的 Git commit。
