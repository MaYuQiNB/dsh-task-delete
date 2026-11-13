# dsh-task-delete · 任务删除

中文 | [English](README.en.md)

给 DSH Web 界面左侧栏「工作区」里的每个任务（会话）加一个**永久删除**入口：

- 鼠标移到任务行上，点右侧的 `...` 菜单；
- 菜单末尾新增 **删除任务**；
- 点它弹出确认框，确认后把该任务从这台电脑上彻底删除。

**任务是否正在运行、是否正在主视图打开都不影响删除**：确认后先停止该任务的工作，再删除本地记录。

## 安装

本仓库是一个完整的 DSH bundle（Host 路由 + Client 界面）：

在 DSH 的 **Plugins** 页选择添加/安装插件，填入本仓库地址：

```text
https://github.com/MaYuQiNB/dsh-task-delete
```

或用 CLI：

```sh
dsh plugin --profile <profile> add https://github.com/MaYuQiNB/dsh-task-delete
```

安装后插件列表里显示为 **任务删除 / Task Delete**。目标环境是 DSH 0.2.x 的
Web GUI 配置（`desktop` / `web` profile）。

## 删除流程

1. 预检日志目录与缓存位置；找不到已物化任务的日志时整体取消，避免误删。
2. 停止任务的工作：通过 Workspace 的归档准入（`stopActivity`）取消进行中的回合、后台任务、子智能体和定时提醒；再显式 `cancel` 存活智能体、等待其空闲、`flush` 已提交事件。
3. 删除：
   - `<DSH_HOME>/sessions/<项目目录>/<任务 ID>/` 会话日志目录（含所有格式代际文件）；
   - `<DSH_HOME>/storages/` 下该任务的投影缓存记录；
   - 该任务下隐藏的子智能体会话日志（它们属于该任务）。
4. 清理刚写入的归档标记，并向界面广播 `api-session/removed`，任务行立即从侧栏消失。
5. 若文件仍被 live 进程短暂占用：带重试删除；仍失败时记入 `<DSH_HOME>/task-delete-pending.json`，插件下次启动时自动补删。

删除的是主视图当前打开的任务时，确认成功后界面会切到一个新的 New Session。

## 安全边界

- 不删除共享附件对象（内容寻址、可能被其他任务引用）。
- 不删除工作区本身；工作区排序记录里残留的任务 ID 不会再显示，也不会重新出现。
- 由该任务创建的定时提醒属于「自动化任务」的独立记录，本插件不会删除它们；需要时请到自动化任务页单独删除。
- 删除不可恢复，没有撤销。

## 开发

纯 ESM、无需构建。用 Node 22+ 运行删除流程测试：

```sh
npm test
```

## 实现

| 半边 | 文件 | 作用 |
|---|---|---|
| Host | `index.js` | `POST /task-delete/delete` 本地路由：连接认证 → 定位任务及子会话 → 停止工作 → 删除日志/缓存 → 广播移除事件（含待清理清单） |
| Client | `client.js` | 注册 `sidebar.workspaces.session.menu.item` 删除行 + `shell.overlay` 确认框；只使用 React 与 theme token，不依赖 Harness Client 包 |
| 显示 | `locale/*.json`、`icon.svg` | 插件管理器的标题、说明与图标 |

## 已知限制

- 删除是不可恢复的硬删除，没有撤销。
- 其他任务引用了被删任务的跨会话消息时，引用处会变成不可读的旧记录。
- live 进程仍持有会话写句柄时，文件删除可能延迟到下次启动补删（界面与持久化列表中已立即消失）。
- 视觉外观按主题 token 实现，当前环境没有浏览器控制，未做截图级视觉验收。

## License

MIT — 见 [LICENSE](LICENSE)。
