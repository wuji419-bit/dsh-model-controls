# DSH Model Controls

作者 / 发布维护：**wuji419-bit**
原仓库：**https://github.com/wuji419-bit/dsh-model-controls**

> 源码可见，禁止未经许可的二次开发；不是 OSI 标准开源项目。使用及原样分享时必须保留署名、许可证与原仓库链接。完整条款见 [LICENSE](LICENSE)。公开仓库的 GitHub Fork 按平台规则仍可能可用，不代表取得二开授权。

## 功能

为 DeepSeek Harness Desktop 中已配置的模型服务（内部 provider ID：`sub2api`）的 GPT 对话模型添加输入框右侧 **⚡ 标准 / ⚡ 快速** 控件；切换速度不改变当前模型及推理等级。快速模式通过请求字段 `service_tier: priority` 表达，可能增加用量，不保证上游提速或特定价格。

- 根据本机能力目录与原 provider 配置的交集暴露推理等级，不虚构上游能力。
- 凭据通过宿主服务读取，不在仓库、前端或会话速度配置中保存密钥。
- 本发布版入口使用集成式 `merged-runtime.js`；`runtime-v2.js` 保留独立 provider 实现及底层测试，不应同时启用两种运行入口。
- 本仓库不包含 DSH 宿主、第三方依赖实现、API 密钥、真实模型目录、会话速度记录或个人配置。

## 兼容性和前提

本项目起源于本机定制插件，不是 DSH 官方插件或通用即装即用包。原实现针对 DSH Desktop 0.2.0-rc.2 的内部接口编写；其他版本、系统、profile 和 provider 命名需要单独验证。未经许可不得修改项目；不兼容时请提交 Issue，由维护者处理。

当前代码依赖：

1. DSH 宿主提供的 `@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-llm`、`@earendil-works/pi-ai`、`yaml` 等组件（不随本仓库分发）。
2. 原有 `llm-pi-ai` 的 `sub2api` provider 已配置 Responses API 及凭据引用。
3. `$DSH_HOME/profiles/desktop/cordis.patch.yml`（默认位于用户主目录的 `.dsh` 下）。
4. 用户主目录下 `.codex/cc-switch-model-catalog.json`，包含模型能力；Fast 需要模型声明 priority。
5. 当前实现将会话速度写入 `$DSH_HOME/plugins/model-controls/session-speed.json`；该文件属于私有运行状态，不得提交。

## 安装说明

先备份 DSH 配置。通过 DSH 支持的本地插件安装方式将本包加入 **同一个 Desktop profile** 的依赖和 bundle，并确认宿主能够解析包名 `dsh-model-controls`。声明文件使用包名解析，未保留原机器的绝对路径。不同 DSH 版本的插件管理方式可能不同，本仓库不提供未经验证的一键安装指令。

原 provider 必须先完成初始化，集成入口才可装饰其适配器；失败时不要启动第二个 Web 服务替代现有 Desktop 实例。确认插件启用后刷新原 GUI。选择已配置模型服务 的受支持 GPT 对话模型即可看到按钮。禁用前建议切回标准模式；禁用插件会尝试恢复原适配器方法。

## 测试

macOS 已安装 DeepSeek Harness Desktop 时：

```sh
sh verify.sh
```

测试调用宿主运行环境和本地 mock HTTP 服务，不调用真实付费推理 API。适配器测试不等于真实上游提速、价格或完整宿主安装验证；客户端测试采用模拟 React/宿主上下文。集成装饰器的完整真实宿主兼容性仍需部署后人工验证。

## 安全与来源

发布副本只包含明确选择的插件源码，未复制本机凭据、profile、历史备份或会话数据。宿主 HTTP 接口的认证边界依赖 DSH，不应直接暴露给不可信网络。本项目有版本绑定的运行时适配行为，升级 DSH 前应复查。

发布者为 wuji419-bit；原始本地文件未提供可验证的公开上游 Git 历史。本仓库仅对发布者有权授权的原创部分主张许可，不声称拥有 DSH 或其他第三方代码。若存在权属问题，请通过 Issue 联系维护者。
