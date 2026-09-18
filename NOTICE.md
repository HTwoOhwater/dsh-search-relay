# NOTICE

本仓库**不是** DeepSeek 官方仓库，而是对 DeepSeek Harness（DSH）自带组件的本地改造版。

包含的第三方代码（均为 MIT 许可，版权归 DeepSeek 所有）：

| 包 | 来源 | 本仓库中的形态 |
| --- | --- | --- |
| `@deepseek-ai/dsh-web-search-deepseek` | `deepseek-ai/deepseek-harness` → `packages/web/web-search-deepseek` | 修改后的完整包（`payload/dsh-web-search-deepseek/`） |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | `deepseek-ai/deepseek-harness`（客户端包） | 只含被修改的文件 + 锚点补丁脚本（`payload/client-ui/`） |

原始 MIT 许可全文见 `LICENSE`（保留 DeepSeek 版权声明，符合 MIT 要求）。

改造内容详见 `docs/CHANGES.md`。本仓库的改造部分同样以 MIT 许可发布。

## 不含任何凭据

仓库中**没有** API Key、token 或 `~/.dsh/.credentials.yaml` 的内容。
`install.mjs` 通过 `--api-key` 参数或手动编辑本机文件来写入密钥，密钥永远不进仓库。
