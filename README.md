# dsh-superagent-qq

QQ 官方机器人 Source 插件：WebSocket 网关长连接实时接收群 @ 消息与单聊（C2C）消息，
走 superagent 引擎标准 准入→评估→Ticket→执行 链路，回复以被动回复直接回 QQ。

## 安装（superagent profile）

```sh
pnpm install && pnpm check
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent restart   # 在 dsh-superagent-prototype 内
```

## 注册机器人（q.qq.com）

1. 在 [q.qq.com](https://q.qq.com) 注册个人开发者并创建机器人，拿到 AppID / AppSecret
2. 在机器人管理页开通「群聊」与「单聊」（C2C）能力；沙箱环境把测试群/成员加入沙箱配置

## 真机验证（M1 门，先于面板配置）

```sh
QQ_APPID=你的AppID QQ_SECRET=你的AppSecret pnpm probe          # 默认 60s
QQ_APPID=… QQ_SECRET=… pnpm probe 120                          # 指定秒数
```

连上网关后：群内 @ 机器人发一条消息 → 应看到 `GROUP_AT_MESSAGE_CREATE` 帧；
机器人单聊发一条消息 → 应看到 `C2C_MESSAGE_CREATE` 帧。

## 配置（面板 Settings → 来源 → QQ 机器人）

1. 机器人账号：填 AppID、AppSecret（名称仅用于面板显示）
2. 接收的群：填该机器人的 AppID 与群 openid —— 获取法：跑 probe 或装好插件后，
   在目标群里 @ 机器人发一条消息，终端日志会打印原始 payload，其中
   `group_openid` 是群 openid、`author.member_openid` 是成员 openid
3. Policy 白名单：把允许派活成员的成员 openid 加入 `allowed`
4. 单聊默认接收；「已收到」回执默认开启（收到消息先被动回复「已收到」，终答随后）

AppSecret 明文存于引擎本地配置（sqlite，仅本机可读）；后续可加凭据绑定方案。

## 待真机核对（M1/M2）

- 事件字段名：`author.member_openid` vs `user_openid`、事件 `t` 名称、`content` 是否带 @ 前缀
- 被动回复窗口时长与单条 msg_id 的被动回复条数上限
