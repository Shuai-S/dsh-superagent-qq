# dsh-superagent-qq

QQ 官方机器人 Source 插件：通过 WebSocket 网关长连接实时接收群 @ 消息与单聊（C2C）消息，
经 superagent 引擎标准 准入→评估→Ticket→执行 链路处理，回复以被动回复直接回 QQ。
断线重连优先 WS resume（op6 携带 session_id/seq），失败自动回退 IDENTIFY。

## 安装

```sh
# 从 npm 安装
dsh plugin --profile superagent add dsh-superagent-qq

# 或从本地源码安装（开发场景）
dsh plugin --profile superagent add "link:$PWD"
```

安装后重启引擎生效。

## 注册机器人（q.qq.com）

1. 在 [q.qq.com](https://q.qq.com) 注册个人开发者并创建机器人，获取 AppID / AppSecret
2. 在机器人管理页开通「群聊」与「单聊」（C2C）能力；沙箱环境需将测试群/成员加入沙箱配置

## 连接自检（可选）

`pnpm probe` 以真实凭据连接网关并打印原始事件帧，用于安装前验证凭据有效性，
以及在配置阶段获取群与成员的 openid：

```sh
QQ_APPID=<AppID> QQ_SECRET=<AppSecret> pnpm probe          # 默认监听 60s
QQ_APPID=<AppID> QQ_SECRET=<AppSecret> pnpm probe 120      # 自定义时长
```

连上网关后：群内 @ 机器人发一条消息 → 应看到 `GROUP_AT_MESSAGE_CREATE` 帧；
机器人单聊发一条消息 → 应看到 `C2C_MESSAGE_CREATE` 帧。

## 配置（面板 Settings → 来源 → QQ 机器人）

1. 机器人账号：填 AppID、AppSecret（名称仅用于面板显示）
2. 接收的群：填该机器人的 AppID 与群 openid —— 通过自检日志获取：在目标群里 @ 机器人
   发一条消息，日志会打印原始 payload，其中 `group_openid` 为群 openid、
   `author.member_openid` 为成员 openid
3. Policy 白名单：将允许派活成员的成员 openid 加入 `allowed`
4. 单聊默认接收；「已收到」回执默认开启（收到消息先被动回复「已收到」，终答随后送达）

AppSecret 以明文保存在引擎本地配置（SQLite，仅限本机读取），不进入日志与会话记录。

## 图片与文件

- 图片：消息文本内嵌 `[qq-image:KEY]` 标记（KEY 为附件 url 的派生哈希），评估时
  经 threadContext.image 按需下载注入会话（需模型支持图片输入）
- 文件/视频：收到消息即落盘到 `~/.dsh/qq-attachments/<msgId>/`（分段下载 + 断点
  续传 + 大小上限），路径与消化提示注入 trigger 文本；单件失败降级不阻塞
