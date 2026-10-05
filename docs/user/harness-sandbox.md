# Harness 沙箱（Fork）

Linux 服务器上的 Claude、Codex 和 Grok 可以使用独立系统用户运行，同时访问同一个 T3 项目。原生 shell、curl、文件操作和开发服务器都在对应沙箱中执行。项目无需复制，创建的持久文件仍归运行 T3 的宿主用户。

宿主需要 Python 3、python3-cryptography、sudo，以及支持 OCI 1.3 idmapped mount 的 runc。此功能需要先准备宿主配置；不支持的宿主或文件系统会报告不可用，不会自动改成宿主执行。

## 准备宿主

在 fork 源码目录安装启动器，将 `dev` 替换为实际运行 T3 的宿主用户：

```bash
sudo python3 scripts/sandbox/install.py --owner dev
```

为每个提供方实例建立一份配置。下面允许 Claude 实例访问 `/home/dev/projects`；目录需先存在，实例 ID 必须与 Settings 中的一致：

```bash
sudo /usr/local/libexec/t3code-sandbox provision claude-main \
  --owner dev --instance claudeAgent --driver claudeAgent \
  --workspace /home/dev/projects
```

Codex 使用 `--driver codex`，Grok 使用 `--driver grok`。新增同种提供方的另一个账号也需要另一份配置和实例 ID。启动器会创建稳定的独立系统用户，以及共享个人空间和实例私有配置目录。

迁移已有隔离账号时，可加 `--execution-user 现有Linux用户名` 保留其身份和工具执行权限。该用户必须独立于 T3 用户、不能是 root，也不能用于另一份沙箱配置；已有配置重新 provision 会保留身份，不能改绑到其他用户。未传入新的网络、目录或 PATH 参数时，保留已有配置；升级桥接目录和软件环境不会自动改成宿主出口。

实例有独立且可写的软件目录，归它自己的系统用户所有。安装官方 CLI：

```bash
sudo /usr/local/libexec/t3code-sandbox install claude-main --version latest
```

该命令先降到实例用户，再在实例的网络命名空间内安装 Node 工具链、npm、pnpm 和 CLI；下载及安装脚本都使用该实例的出口。安装后在提供方设置中将 Binary path 填为 `/var/lib/t3code-sandboxes/software/claude-main/bin/claude`。Codex、Grok 对应 `bin/codex`、`bin/grok`。此后可在客户端点击更新，由同一实例用户执行。旧配置需要重新 provision 才有软件目录；继续使用只读旧安装时，更新仍显示为手动操作。

系统 `/usr` 中的工具保持只读。额外运行时和依赖可用 `--readonly /实际工具目录` 开放，并用 `--path /工具目录:/usr/bin:/bin` 配置查找路径。只开放所需目录。附件所需目录也需要单独开放；不要开放 T3 的整个数据目录或秘密目录。

开放 CLI 时要包含同一安装包内的资源和辅助程序。例如 Codex standalone 应开放整个 release 目录，而非只开放其中的 `bin`。

默认网络沿用宿主网络，可以按实例 UID 配置出口，但不隔离宿主端口。已有独立网络命名空间可使用 `--network-namespace /run/netns/名称 --mcp-host T3可达地址`；需事先配置该空间的路由和出口，并让 T3 的 MCP 端口可从该地址访问。DNS 从 root 所有且不可由普通用户修改的 `/etc/netns/名称/resolv.conf` 读取，也可用 `--resolv-conf /绝对路径` 指定。该文件中的 DNS 地址须从命名空间可达。启用后不会自动切回宿主网络。

如果出口规则禁止连接宿主地址，可以用安装器附带的 `t3code-mcp-relay.py` 建立私有 Unix socket 通道：宿主端使用 `--listen-unix /私有目录/mcp.sock --connect-tcp T3端口`，命名空间端使用 `--listen-tcp T3端口 --connect-unix /私有目录/mcp.sock`，两端以 T3 用户运行。命名空间端由 systemd 的 `NetworkNamespacePath` 加入现有网络，配置 `--mcp-host 127.0.0.1`。这不更改出口路由；若 T3 或通道停止，MCP 不可用，Harness 不会切回直连。两端只监听本机，socket 权限为 0600，T3 仍验证每次请求的会话凭证。

## 在客户端启用

Web 和桌面：**Settings → Providers → 选择实例 → Execution environment**。开启 Linux sandbox，填写宿主配置名称，例如 `claude-main`。

移动端：**Settings → Environments → 选择环境 → Execution environment**，开启对应实例并保存配置名称。关闭开关可以恢复该实例原有的运行方式。

配置切换会重建该提供方的运行实例，适合在当前工作结束后操作。首次使用私有配置目录时，需要按厂商正常方式登录该实例；不会自动复制其他账号的登录状态。Codex 的 Shadow home 必须清空，沙箱配置负责提供实例目录。

Codex 可直接通过实例的 **Codex account → Sign in with ChatGPT** 发起设备码登录；移动端入口在所选环境的 **Codex account** 中。打开显示的授权链接并输入验证码即可，无需 SSH。登录与退出都使用该实例的私有配置和出口，凭证仍由官方 Codex 保存和刷新。详见 [Codex 登录指南](./providers-codex.md#sign-in-from-t3-code)。

Claude 和 Grok 实例也可在相同位置登录：[Claude](./providers-claude.md#sign-in-from-t3-code) 打开授权链接后，将浏览器给出的授权码填回 T3；[Grok](./providers-grok.md#sign-in-from-t3-code) 在官方授权页面输入或确认设备码。两者的登录、退出都在实例既有的身份、私有目录和网络内执行，无需改变宿主保护配置。

实例环境变量会被明确传入沙箱，进程仍能读取这些值；它们不等同于下述凭证库。服务器环境变量不会整体继承。

沙箱实例的技能扫描和文件下载工具也受其已开放目录限制。修改或关闭沙箱配置会使旧 MCP 会话凭证失效，避免旧授权沿用新的文件范围。

Claude 的额外额度重置查询和 Grok 的补充账户查询暂不在沙箱模式提供；聊天、原生工具及协议返回的状态仍走实例环境。

## 凭证库与私密输入

Web 和桌面在 **Settings → Providers** 的当前环境下管理“凭证库”；移动端在 **Settings → Environments → 选择环境** 下管理。每个 T3 环境由一个资源所有者管理，项目、凭证和 MCP 服务统一归其所有，按 Harness 实例分配使用权限。GitHub 登录和配对用于认证访问这个环境。资源管理需要环境管理员权限，普通配对连接可能没有此权限。凭证库按环境保存，跨环境不会同步。

可以主动添加变量，填写私密值、说明和允许使用的提供方实例。编辑时留空保留现有值；删除或撤销使用权会停止后续新命令领取变量。值不会通过查看接口返回。

Agent 也可通过 MCP 请求私密输入模板。当前聊天会出现填写入口，说明变量名称和用途。直接在表单中填写即可，不需要将值发到对话中。工具会等待最多十五分钟；保存或取消后，Agent 自动继续当前回合，收到配置结果而非私密值。填写后 Agent 可以申请使用，随后通过原生 shell 的 `$变量名` 调用程序。授权默认有效十五分钟；到期后可以再次申请。

凭证使用需要开启 Linux 沙箱，并使用本版本安装器安装的 shell 启动入口。已有沙箱配置需重新 provision，以生成实例独立的凭证桥接目录。整个流程不修改 Harness 源码，也不替换它的模型认证。为兼容禁止 Unix socket 的内层沙箱，系统还发布只读、按会话 AES-GCM 加密的短期授权文件；文件不含明文值，启动入口仅在执行时解密并检查有效期。Shell 的桥接凭证仅能领取已授权变量，不能访问 MCP HTTP 工具。

持有变量的执行子进程能读取真实值。系统在外部命令边界过滤本次注入值的原样标准输出和错误输出，不能保证过滤编码或变形的值。命令内部的 Git、npm 等协议管道保持原生；没有有效变量授权时，shell 直接执行。撤销不清空已经运行的进程。

## 托管第三方 MCP

在同一环境的“托管 MCP 服务”添加服务。支持本地 stdio 和远程 Streamable HTTP，转接 tools、resources 和 prompts，自动接入 Claude、Codex 和 Grok。服务命令在运行 T3 的用户环境中执行，因此可以使用该用户已安装的 MCP 程序，与 Harness 的独立系统用户和出口分开。

配置中绑定凭证名称，不填写凭证值。本地服务的示例：

```json
{
  "id": "nai",
  "label": "NAI",
  "enabled": true,
  "allowedInstances": ["claudeAgent", "codex", "grok"],
  "transport": {
    "type": "stdio",
    "command": "/usr/bin/node",
    "args": ["/home/dev/services/nai/server.js"],
    "cwd": "/home/dev/services/nai",
    "environment": { "NAI_TOKEN": { "credential": "NAI_TOKEN" } }
  }
}
```

远程服务使用下列 transport：

```json
{
  "type": "http",
  "url": "https://your-service.example/mcp",
  "headers": { "Authorization": { "credential": "SERVICE_TOKEN", "prefix": "Bearer " } }
}
```

服务和所绑定凭证都必须允许当前实例使用。添加或删除服务后，重新连接 Agent 会话，以便原生 Harness 重新加载服务列表。连接按会话隔开；停止、重启或删除会释放对应进程，重启在下一次连接时启动。凭证变更后，后续请求会重新建立使用新值的服务连接。程序启动错误显示为“错误”，请检查可执行文件、参数、依赖、目录和变量绑定。

同一 Agent 会话可同时连接多个 MCP 客户端，客户端分别握手和关闭。第三方服务的 `instructions` 会通过原生 MCP 协议转接；Harness 如何将它显示或纳入模型上下文，由 Harness 决定。

### 从脚本调用

Agent 先调用 `mcp_list_services`，再通过 `mcp_request_script_access` 申请某个服务的工具列表，收到私有 context 文件路径。随后可用安装器提供的通用客户端：

```bash
t3-resource mcp tools --context /返回的/context.json
t3-resource mcp call 工具名 --context /返回的/context.json --json-file request.json
```

也可将 JSON 参数通过标准输入传入。客户端处理握手和连接关闭，输出 MCP 结果 JSON。授权默认十五分钟，最长一小时，只能调用指定服务和工具，不能调用凭证库或服务发布工具；可以通过 `mcp_revoke_script_access` 撤销，父会话停止时也会撤销。Context 文件包含短期脚本授权，供执行进程读取，不能发到对话中。业务凭证仍由 T3 托管。

脚本地址按实例的 `mcpHost` 生成，需要从该实例的 shell 可达。若 Harness 自带沙箱禁止 shell 联网，仍需通过其原生权限流程允许这次访问；T3 的脚本授权不会覆盖厂商的网络权限。

### 适配工具说明与文件参数

托管配置可以加入 `exposure`，筛选 `allowedTools`、覆盖 `instructions`、工具和参数说明，以及按工具删去返回值中的指定字段。适配应使用调用方能够访问的地址与路径；不要把宿主管理接口当作脚本入口。通用适配不会自动翻译任意第三方程序的路径。

Phoenix 上的 NAI 服务使用以下适配配置：

```json
{
  "adapter": {
    "kind": "nai",
    "artifactDirectory": "/home/dev/nai-agent/outputs"
  }
}
```

NAI 适配隐藏宿主 HTTP 旁路，说明 `human_request_id` 只是任务关联标签，并检查输入文件确实是当前实例共享目录内的 PNG 或 WebP。输出目录需要以只读挂载开放给实例。Agent 可以用 `nai_delete_artifact` 按生成结果中的 artifact ID 删除产物，无需获得目录写权限。接入其他 MCP 时，应在实际沙箱中验证描述、返回路径和脚本调用。

本阶段不提供第三方服务的安装器或 OAuth 授权界面，也不转接 sampling、elicitation 和旧版 HTTP+SSE。已安装的 stdio MCP 和使用既有认证的 Streamable HTTP MCP 可直接托管。

## 临时服务共享与公网发布

配置私网服务网络后，Claude、Codex 和 Grok 可以用原生 shell 启动服务；各实例可使用相同端口。让服务监听自己的私网 IP 或 `0.0.0.0`，其他实例默认不能连接，公网也不能直接访问。

可以让 Agent 调用 `service_list` 查询实例和私网地址，调用 `service_share` 把自己的一个 TCP 端口临时开放给指定实例。接收方随后直接访问返回的 `privateUrl`。默认有效期为一小时，最长一天；服务所有者可用 `service_unshare` 随时撤销。共享不开放公网，也不共享凭证。

需要公网访问时，让 Agent 用 `service_publish` 注册已经运行的 HTTP 服务，传入服务名称、端口和独立域名；域名须在管理员允许的范围内，并先将 DNS 指向服务器。T3 和已有服务的域名不能用于发布。独立域名使应用与 T3 登录界面保持不同浏览器来源，应用也能正常使用根路径资源。`service_unpublish` 撤销公网路由，服务继续在私网运行。发布接口不托管进程，服务可能随 Harness 会话结束而停止；长期服务可使用下方的业务应用发布。

服务器管理员先安装沙箱启动器，再准备私网配置并运行：

```bash
sudo python3 scripts/sandbox/install_service_network.py --config /root/t3-service-network.json
```

配置示例，按服务器实际网卡、T3 端口和既有出口名称调整：

```json
{
  "owner": "dev",
  "publicHost": "agent.example.com",
  "allowedDomainSuffixes": ["example.com"],
  "reservedHosts": ["agent.example.com", "nai.example.com"],
  "mcpPort": 3773,
  "privateSubnet": "10.233.0.0/24",
  "egressInterface": "eth0",
  "networkDependencies": ["claude-egress-network.service"],
  "profiles": {
    "claude-remote": {
      "namespace": "claude-egress",
      "address": "10.233.0.2/30",
      "gateway": "10.233.0.1",
      "preserveEgress": true,
      "relayUnit": "t3code-mcp-relay-claude.service"
    },
    "codex-main": {
      "namespace": "t3-codex-main",
      "address": "10.233.0.6/30",
      "gateway": "10.233.0.5"
    },
    "grok-main": {
      "namespace": "t3-grok-main",
      "address": "10.233.0.10/30",
      "gateway": "10.233.0.9"
    }
  }
}
```

目前支持使用 nftables 兼容 INPUT/FORWARD 链的 Linux 宿主及 Caddyfile 配置。既有固定出口需有 `inet claude_guard` 防火墙；保留出口模式不会更改其默认路由。地址段必须避开现有网络。安装器会保留原有 Caddy 站点并添加托管路由入口；安装前备份 Caddyfile 和实例配置。将网络服务及各 MCP relay 加入 T3 服务的 systemd `Requires` 和 `After`，再重启 T3，让新会话使用私网配置。已有 relay 可通过 `relayUnit` 复用，避免重复监听同一端口。

## 常用工具授权与框架保护

T3 上的 GitHub CLI 已登录时，新启动的托管实例自动继承当前账号及其 GitHub 权限，无需逐个添加授权。Agent 直接运行 `gh pr list` 等原生命令，T3 在工具启动时提供认证，普通 shell 环境中没有该 Token，也不共享宿主认证文件。T3 退出 GitHub 登录后，继承授权随之失效。

资源设置中的 **Native gh tool bindings** 可按实例撤销、重新启用或覆盖默认授权。撤销后不会自动恢复，重启和新会话也会保持撤销；选择“继承 T3 GitHub 授权”可清除覆盖并恢复默认行为。显式 `host-login` 覆盖会固定所填写的账号，`repositories` 应留空。撤销影响后续工具启动，已经运行的程序需结束后重新启动。

同一绑定也用于 GitHub HTTPS 仓库的 `git clone/fetch/push`，系统自动配置认证助手，无需运行 `gh auth setup-git`。仅在 Git 需要认证时取得凭证，普通本地 Git 操作不领取 Token。直接运行 `gh auth token` 或 `git credential fill` 的秘密输出仍会被遮蔽。更新沙箱启动入口后需新建会话，已有会话保留原来的挂载与环境；SSH 地址与其他 Git 托管平台仍使用各自的认证配置。

需要 GitHub 侧限定业务仓库时，可选择可续期的 GitHub App，或凭证库/宿主 gh 中的 App installation token。App 私钥通过凭证名称引用，用途设为 **Tool bindings only**；模型不能申请将其注入 shell。installation 的实际仓库集合必须与选择的集合一致，且不包含管理框架仓库。T3 网页 GitHub 登录用于访问认证，不能单独替代 GitHub CLI 的仓库授权。

管理员登记框架源码和管理目录后，沙箱内的相应路径只读或隐藏，即使它们位于可写共享父目录中。业务发布也拒绝包含这些路径的项目、父目录及别名。Agent 可开发和维护业务应用，管理这些 Agent 的 T3 本身由独立维护环境更新。

## 业务应用发布与运维

应用可以使用 Docker Compose，或使用管理员按项目登记的 systemd 原生服务配置。两种方式都独立于聊天和 T3 进程运行。以下先介绍 Docker 发布；无需 HTTP 端口的 Bot 及指定运行用户的服务见后文。

Docker 发布需由管理员先安装 Docker Engine、Compose v2、Buildx 和 python3-yaml，安装上述启动器，再登记保护范围和发布域名。例如：

```bash
sudo python3 scripts/sandbox/install_resource_management.py --owner dev \
  --protect-read /home/dev/src/t3code \
  --protect-hidden /home/dev/.t3-resources \
  --protected-repository owner/t3code \
  --reserved-host agent.example.com \
  --domain-suffix example.com --enable-applications --configure-caddy
```

业务项目提供标准 Dockerfile 和 `compose.yaml`。首版支持至多八个长期服务，每个服务必须声明健康检查；容器以 T3 宿主用户的 UID/GID 运行。声明容器端口即可，T3 自动分配宿主回环端口。持久数据使用 T3 管理的命名卷；项目相对目录仅支持只读快照挂载。宿主网络、root 身份、Docker socket、外部卷、设备和任意宿主挂载不支持。以下声明使用项目 Dockerfile，并把凭证库中的 `BLOG_API_TOKEN` 绑定给服务：

```yaml
services:
  web:
    build: .
    ports: ["8080"]
    volumes: ["data:/app/data"]
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8080').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 12
volumes:
  data: {}
x-t3:
  credentials:
    web:
      API_TOKEN: BLOG_API_TOKEN
```

构建快照包含未提交代码，排除 `.git`、依赖缓存、`.env`、私钥等秘密文件；运行凭证应使用上述绑定。首版容器环境绑定支持单行值；多行私钥可用于工具绑定。通过应用工具启动、重启和回滚会重新验证凭证权限与发布时的值/版本；删除或轮换后需重新发布，已有运行进程的环境不会被追溯清空。Docker/systemd 的自动恢复使用已发布绑定，轮换后应重新发布。应用镜像需为非 root 身份准备可写目录；容器内诊断还需安装标准 `timeout` 工具。

让 Agent 调用 `environment_info` 查看实际环境，调用 `application_publish` 创建发布任务，再用 `application_status` 等待结果。客户端资源设置也可发布和管理应用。新应用不指定域名时无公网入口；显式指定独立域名才通过 Caddy 发布，DNS 必须预先指向服务器。公开任务只有在 HTTPS 实际到达该发布版本时才成功，DNS、证书或代理失败会尝试恢复旧版本与路由。更新省略域名会沿用原域名，传 `hostname: null` 可移除公开入口。私有后端仅宿主可达，Agent 通过应用日志和容器诊断工具维护。

首版更新采用替换策略：先构建，再停止旧版并启动新版，通过健康检查后切换入口；失败时尝试恢复旧版。发布成功的版本记录源码摘要、Git 提交、实际镜像和凭证版本。停止、启动、重启、查看日志及版本历史、回滚和撤回均可通过应用工具或资源设置操作；容器内诊断通过 `application_exec`。已授权访问同一业务项目的其他 Harness 也可维护该应用。

Docker 使用 `unless-stopped`，业务进程退出时按策略重启，主动停止后不会因机器重启恢复。健康不良本身不触发自动重启。回滚只恢复代码、配置和该版凭证，保留持久数据；数据库迁移需按业务自身的恢复流程处理。撤回会移除容器和公网路由，保留数据与历史，可以重新启动或发布。

### 原生 Bot 与指定运行用户

选择 **systemd** 后端可以托管无需域名或 HTTP 端口的 Bot。宿主管理员先为项目、应用名称和 Harness 实例登记部署授权，指定已有的运行用户及构建、运行限额；Harness 随后可发布和维护该应用。构建始终使用普通 T3 宿主用户。运行用户可以是专用业务用户，确需 UID 0 时管理员必须显式设置 `allowRoot: true`。

这里的 root 运行在应用私有的文件系统和 PID 空间中，默认无 Linux capabilities；不能访问宿主 `/root`、其他进程、Docker socket 或 T3 管理目录。程序在 `/app` 读取发布版本，向 `/data` 写入持久数据，临时文件放在 `/tmp`。系统解释器和动态库以只读方式提供。依赖必须可在构建阶段安装到项目目录，例如 Python venv 或 Node 的 `node_modules`，不能在构建时使用 apt 或向宿主安装软件。需要管理整台宿主的程序仍由维护端部署。

维护端需安装 systemd 257+、python3-yaml，并支持 cgroup v2 的 memory/cpu/pids 控制器、PID 命名空间及 socket bind BPF 策略。更新上述启动器以安装新的应用代理模块。资源安装器会运行一个短暂且受限的预检服务，实际确认 PID 隔离和端口策略可执行；不满足条件时拒绝登记配置。

在 **设置 → 资源 → 应用发布 → 部署授权** 中选择实际 Harness 实例，创建授权并检查项目目录、应用名称、运行身份、网络、监听端口及构建/运行限额。业务项目目录必须已经存在。默认使用普通宿主用户，并沿用当前 Harness 的网络出口；需要 root 时选择 root，并在审核页明确确认。DNS 副本由 T3 自动准备，无需编辑 JSON 或通过 SSH 登记每个项目。

也可以直接让 Harness 为 Bot 准备部署申请。它通过 `application_request_deployment` 提交草稿，你在同一设置页面查看、调整、批准或拒绝；`application_deployment_requests` 可查看结果，`application_cancel_deployment_request` 可撤回待审核申请。只有管理员客户端能够批准。修改同名待审核草稿会撤回旧申请，旧页面不能继续批准旧版本。授权申请跨 T3 重启保留；批准只登记权限，不会立即发布应用。

每份新授权绑定当前实例、一个确切项目及应用名称，不扩大为整个工作区的 root 权限。已有授权可在页面查看；停止应用后再撤销，保留发布历史及业务数据。替换同名授权须先撤销原授权，再创建、审核并重新发布。修改运行用户不会自动迁移已有 `/data` 内容的所有权，需维护端按业务需要处理。原有维护端登记的授权仍可使用。

应用网络不会改写 Harness 出口。选择沿用实例出口时会绑定当前已配置的命名空间；选择宿主网络则使用宿主出口。命名空间不可用时拒绝授权或发布，不回落到宿主网络。默认不允许监听端口；确需监听时在表单填写非保留的 TCP 端口，程序自行决定监听地址。原生服务不自动创建 Caddy 公网路由；需要托管 HTTP 发布时继续使用 Docker 后端。

首次启用仍由维护端安装或更新启动器、应用代理及管理员授权入口，并登记框架保护范围、仓库和实例映射。T3 管理员批准原生授权时会执行受限的隔离预检；失败则不登记授权。日常授权创建、审核和撤销均在图形界面完成。

项目提供 `application.yaml`，例如 Python Bot：

```yaml
build:
  - ["/usr/bin/python3", "-m", "venv", "/app/.venv"]
  - ["/app/.venv/bin/pip", "install", "-r", "/app/requirements.txt"]
command: ["/app/.venv/bin/python", "/app/bot.py"]
environment:
  PYTHONUNBUFFERED: "1"
credentials:
  BOT_TOKEN: BOT_API_TOKEN
healthcheck:
  type: process
```

`BOT_API_TOKEN` 是凭证库名称。`runtime.timeoutSeconds` 限制发布检查的等待时间，不限制长驻服务寿命。运行凭证不传给构建命令。声明 `process` 检查只确认主进程正在运行；若需功能验证，使用 `healthcheck: { type: command, command: ["/app/.venv/bin/python", "/app/check_ready.py"] }`。检查命令在同样的应用文件系统、网络和运行身份下执行，拥有独立 PID 空间，可通过 `/data` 或应用接口检查状态。

刷新客户端的应用列表，选择 systemd 和已登记配置后发布；Harness 也可调用 `application_publish`，传 `backend: "systemd"`、`deploymentProfile: "my-bot"`、项目目录和应用名称。更新仍使用原 `applicationId`，不能借更新更换后端或授权配置。构建结束后冻结产物并记录摘要，编辑工作区不会改变运行版本。

更新先停止旧版，再启动和检查新版，以避免两个 Bot 同时消费消息；存在短暂中断。新版检查失败时先确认其已停止，再尝试恢复旧版，恢复结果记录在任务中。服务通过检查后才启用开机启动；进程异常退出由 systemd 重启，连续失败会触发频率限制。主动停止会禁用开机启动；撤回保留数据和版本，后续可重新启动。回滚保留 `/data`，不回滚业务迁移。日志、状态、历史版本和诊断沿用应用工具；`application_exec` 使用同授权的临时服务，不是宿主 shell，也不能直接查看主服务的 PID 空间。

发布失败后，在应用管理中查看状态和“部署诊断”。构建步骤、退出状态及对应单元的近期 journal 会在清理或恢复旧版前保存；首次发布失败也能查看，不要求先有运行版本。Harness 可通过 `application_status` 的任务诊断和带该 `operationId` 的 `application_logs` 读取这些证据，修改业务项目后重新发布。运行中的服务异常也会在状态查询中提供当前诊断，与历史发布失败分开展示。日志经过凭证脱敏且有大小限制；界面会注明截断、无记录或读取失败。旧版本没有保存的临时构建日志无法事后补回。若证据指向宿主或隔离环境故障，应交给维护端修复，不应放宽部署授权来绕过错误。

### 构建与运行资源限额

原生服务的构建与运行分别限制内存、CPU 和进程数，健康检查及并发诊断与主服务共享应用运行总限额，禁用 swap，并限制构建总时长。原生与 Docker 构建共用宿主级排队锁，一次仅构建一个应用；该限额不包含其他宿主程序，管理员仍需为 T3 和系统留出余量。

Docker 构建使用专用的 `docker-container` BuildKit 实例，启动后核验其实际内存、CPU 和 PID 限额，结束或失败后停止该构建实例，不修改宿主默认 builder。默认构建限额为 2048 MiB、100% CPU、256 个进程、1200 秒。管理员可通过 `--build-memory-mib 1024 --build-cpu-percent 100` 调整内存和 CPU，或在可信资源策略的 `applications.build` 中设置全部限额；运行容器仍使用已有 Compose 限额。需安装支持 `docker compose build --builder` 和 Buildx `default-load` 的版本。版本或限额不满足要求时构建失败，不退回无限额构建。
