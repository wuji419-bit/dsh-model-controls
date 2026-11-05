# DSH Model Controls

作者 / 发布维护：**wuji419-bit**
原仓库：**https://github.com/wuji419-bit/dsh-model-controls**

> 源码可见，禁止未经许可的二次开发；不是 OSI 标准开源项目。使用及原样分享时必须保留署名、许可证与原仓库链接。完整条款见 [LICENSE](LICENSE)。公开仓库的 GitHub Fork 按平台规则仍可能可用，不代表取得二开授权。

## 功能

为 DeepSeek Harness Desktop 中已配置的 **GPT 对话模型**添加输入框右侧 **⚡ 标准 / ⚡ 快速** 控件。**不要求 API 接入使用任何固定名称或 provider ID**；改名、添加多个接入或把同一个 GPT 模型配置在不同接入中，都不需要修改插件源码。切换速度不改变当前模型及推理等级。

- 自动从宿主已注册的模型适配器识别模型：模型 ID 以 `gpt-` 开头（大小写不敏感），排除 `gpt-image-*` 等图像模型。
- 支持宿主 pi-ai 适配器的 `openai-responses` 和 `openai-completions` 协议；按模型真实协议分别使用 `reasoning.effort` 或 `reasoning_effort`。其他协议和非兼容适配器不注入控件，也不改写请求。
- 直接沿用原接入的配置快照、地址、凭据解析、请求头、模型限制和工具/图片处理；不重新创建 provider，也不读取或重写原 profile 中的 provider 名称。
- 按本机能力目录声明提供额外推理等级；没有目录或没有对应模型记录时，保留宿主原能力，不虚构等级。
- 快速模式通过 `service_tier: priority` 表达，**只有能力目录明确声明 priority 时才允许开启**。没有声明的 GPT 模型仍能被识别，但按钮保持标准并禁用快速切换，不会把缺少 Fast 能力当成请求失败。
- 快速模式可能增加用量，不保证上游提速或特定价格；目录声明也不替代真实服务端的支持情况。
- 速度选择按**会话 + provider ID + 模型 ID**隔离；切换接入会重新读取对应状态，不会把其他接入的快速选择误套过来。
- 多个接入共用一个宿主适配器时只装饰一次；新增或替换适配器时自动同步，禁用插件时恢复原方法。
- 本发布版入口使用集成式 `merged-runtime.js` 和 `provider-controls.js`；`runtime-v2.js` 保留独立路由实现及底层测试，不应同时启用两种运行入口。
- 本仓库不包含 DSH 宿主、第三方依赖实现、API 密钥、真实模型目录、会话速度记录或个人配置。

## 兼容性和前提

本项目起源于本机定制插件，不是 DSH 官方插件或通用即装即用包。原实现针对 DSH 0.2.0-rc.2 的内部接口编写。0.1.1 已分别使用 Windows 本机的官方 DeepSeek Harness（宿主 0.2.1-rc.5）与 DSH Desktop v2.0.17（宿主 0.2.0-rc.2）的实际运行库通过 81 项测试，包括真实适配器与本地 mock HTTP；这不等于真实上游或完整 GUI 人工验收。支持官方版的 ASAR 与社区桌面版的解包目录，不会为了兼容而安装另一份宿主依赖。未经许可不得修改项目；不兼容时请提交 Issue，由维护者处理。

当前代码依赖：

1. DSH 宿主及其 pi-ai 适配器。必须先正常配置模型服务和凭据；服务名称任意，但宿主本身需要能正常使用该服务。
2. 集成入口从宿主的有效配置快照获取 provider 与模型信息，不再依赖 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中某个固定 provider 键。
3. 用户主目录下的 `.codex/cc-switch-model-catalog.json` 用于补充推理等级和 priority 能力。文件缺失时不阻塞原接入，插件保留原能力并禁用未声明的快速模式。
4. 当前实现将速度选择写入 `$DSH_HOME/plugins/model-controls/session-speed.json`，`DSH_HOME` 默认是用户主目录下的 `.dsh`；该文件属于私有运行状态，不得提交。
5. 独立路由实现和底层测试仍需宿主提供的 `@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-llm`、`@earendil-works/pi-ai`、`yaml` 等组件（不随本仓库分发）。

## 安装说明

先备份 DSH 配置。通过 DSH 支持的本地插件安装方式将本包加入 **同一个 Desktop profile** 的依赖和 bundle，并确认宿主能够解析包名 `dsh-model-controls`。声明文件使用包名解析，未保留原机器的绝对路径。不同 DSH 版本的插件管理方式可能不同，本仓库不提供未经验证的一键安装指令。

同时安装官方版与 DSH Desktop 社区版时，先确认各自当前的数据目录和 Profile；社区版可以选择独立数据目录，不能假定两者共用默认 `.dsh`。每个需要使用的 Profile 都必须将本包列入依赖和 `dsh.profile.bundles`；仅更新另一个安装目录不会自动启用当前版本。安装后由用户重开对应桌面程序使插件生效。

原模型服务必须正常初始化；插件自动跟随已注册的兼容适配器，也会等待稍后注册的接入，不需要重命名 API。失败时不要启动第二个 Web 服务替代现有 Desktop 实例。确认插件启用后刷新原 GUI，选择已配置服务中的 GPT 对话模型。禁用前建议切回标准模式；禁用插件会恢复原适配器方法。

### 从 0.1.0 升级

0.1.0 的速度记录只有会话 ID，无法知道原来选择的是哪个接入。为防止升级后误开启其他服务的可能收费快速模式，**旧的无 provider 记录不自动套用到任何接入**；升级后需在目标接入上重新选择一次快速模式。首次保存时写入 version 2 的按接入/模型隔离格式，原会话和模型配置不受影响。

不要混用旧版前端和新版后端：新版速度 RPC 必须同时携带 `sessionId`、`provider` 和 `model`；升级后应刷新原 GUI。

## 测试

不需要宿主的纯逻辑、客户端与速度 RPC 测试：

```sh
node --test test/client.test.js test/provider-controls.test.js test/runtime.test.js test/host-import.test.js
```

macOS 已安装 DeepSeek Harness Desktop 时，可使用完整宿主测试：

```sh
sh verify.sh
```

Windows 完整测试需要使用已安装 DSH Desktop 的 Electron 可执行文件，并在子进程中设置 `ELECTRON_RUN_AS_NODE=1` 后传入 `--test test/*.test.js`。普通系统 Node 不一定能解析宿主 ASAR 中的依赖，不要因此另外安装宿主包或启动第二个 Desktop 实例。

完整测试调用宿主运行环境和绑定在 `127.0.0.1` 的本地 mock HTTP 服务，不读取个人凭据、不调用真实付费推理 API。覆盖运行宿主打包目录解析、任意接入名、多接入同名模型、两种协议的真实 HTTP 字段、原地址/凭据/请求头保留、准备调用的配置快照、会话状态隔离、持久化、升级、适配器热更新/恢复和前端切换竞态。

适配器测试不等于真实上游提速、价格或完整宿主安装验证；客户端测试采用模拟 React/宿主上下文。真实 GUI 兼容性仍需部署后人工验证。

## 安全与来源

发布副本只包含明确选择的插件源码，未复制本机凭据、profile、历史备份或会话数据。宿主 HTTP 接口的认证边界依赖 DSH，不应直接暴露给不可信网络。本项目有版本绑定的运行时适配行为，升级 DSH 前应复查。

发布者为 wuji419-bit；原始本地文件未提供可验证的公开上游 Git 历史。本仓库仅对发布者有权授权的原创部分主张许可，不声称拥有 DSH 或其他第三方代码。若存在权属问题，请通过 Issue 联系维护者。
