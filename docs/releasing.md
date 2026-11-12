# 发布

本地怎么打包、推标签之后工作流做什么、npm 那边要先配什么，都在这页。想改代码看
[development.md](development.md)。

## 本地打包，不发出去

```sh
pnpm run build           # 生成接口编解码 + 打出 lib/index.js 与 lib/client.js
pnpm run check:package   # 用 npm 自己的打包规则核对内容（要先 build）
pnpm run pack:release    # 构建并打包到 artifacts/，产物是 he0119-dsh-notifications-<版本>.tgz
```

`artifacts/` 里的 tarball 可以直接装进 DSH 试用：插件管理器里选「添加插件」，装这个文件。
它和发到 npm 的那份是同一套 `files` 白名单打出来的。

## 正式发布

版本号只有一个来源：`package.json` 的 `version`。发布提交先把它改好，然后在那个提交上打
`v<版本>` 标签，推标签触发 [publish.yml](../.github/workflows/publish.yml)。

```sh
# 1. 改 package.json 的 version，连同改动一起提交
npm version <版本> --no-git-tag-version   # 版本号只改 package.json，标签自己打
git add package.json && git commit -m 'chore(release): <版本>'

# 2. 在发布提交上打标签，推上去（只推标签也算，但推 main 更省事）
git tag v<版本>
git push origin main --follow-tags
```

工作流按这个顺序走：

1. **完整检查**：复用 [ci.yml](../.github/workflows/ci.yml)（生成编解码、类型检查、构建、测试、包内容自检）。
2. **标签校验**：`v1.2.3` 要能解析成版本号；标签指向的那个提交里 `package.json` 的 `version` 必须就是
   `1.2.3`；那个提交还必须在 `main` 上。三件事有一件不成立就停在 npm 之外。
3. **装依赖、构建、包内容自检**：`lib/` 不进 git，靠 `prepublishOnly` 现场编译，所以这一步不能省。
4. **该版本是否已在 npm 上**：已经在就跳过发布并视为成功——重跑同一次工作流不会报错。
5. **发布**：`npm publish`，凭据由 npm 的可信发布（OIDC）现场换，仓库里不存 token。
6. **建 GitHub Release**：发布确认之后才建；已存在就跳过。变更列表由 GitHub 按提交生成，起点是上一个
   标签。

## npm 那边要先配的两件事

- **包名归属**：`@he0119/dsh-notifications` 挂在 npm 账号 `he0119` 的 scope 下，发布者要属于该 scope；
  换人维护要先转到新的 scope，旧 scoped 名字不跟着包走。
- **可信发布**：在 npm 包的 Settings → Trusted publishing 里登记 GitHub 仓库与工作流文件名
  `publish.yml`。没登记时工作流会在 `npm publish` 那一步被拒（`E404` 或 `ENEEDAUTH`），
  不会误发。
- **新包要先有一次手动发布**：设置页只在包已经存在于 npm 上之后才有，所以全新包名得先用
  `npm publish` 发一次（需要在终端里输一次 OTP），再去配可信发布。配好之后，npm 要求这份配置在
  **2 天内完成一次由 CI 发起的成功发布**才算生效，否则过期要删掉重配——所以配完紧接着打一个标签，
  别等。手动发的那一次不算验证：工作流会在「判断该版本是否已经发布」那步跳过它。

如果改用长期 token 发布（在仓库里存 `NPM_TOKEN`，工作流里配 `NODE_AUTH_TOKEN`），要同时改两处：
`npm publish --provenance`，以及给 `package.json` 补上指向本仓库的 `repository` —— 来源证明要求
两者都在。

## 出错时

- **刚发的版本查不到**：`npm publish` 成功时会打印 `Your package is being processed and may take a
  few minutes to become available`。这期间 `npm view` 与 tarball 地址都是 404，属于等待而不是失败
  （0.1.1 实测 285 秒后才可查）。别在这时重发。

- **`版本已存在`**：说明这个版本号已经发过。要么换版本号重来，要么什么都不做（跳过发布视为成功）。
- **`标签 ≠ package.json`**：标签打在了别的提交上。删标签重打到发布提交：
  `git tag -d v<版本> && git tag v<版本> <发布提交> && git push origin :refs/tags/v<版本> && git push origin v<版本>`。
- **`不在 main 上`**：先把提交合进 main，再在 main 上重打标签。
- **本地产物坏了**：`pnpm run build && pnpm run check:package` 先复现，再改；发布工作流跑的就是这两步。
