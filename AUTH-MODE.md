# AI加词 (Jiaci) 双模式认证 / 私有化部署覆盖包

非官方社区修改，基于 2026-11-22 看到的 https://github.com/leoon-hu/jiaci/main 的文件结构。仅覆盖认证入口与登录页面，不包含上游项目代码。**未完成连接真实生产数据库的端到端测试，也未对整站完成安全审计。** 上游更新后必须复核覆盖文件。

## 效果

- `AUTH_MODE=email`：保留原版邮箱验证码登录及首次登录自动注册；`/api/auth/api-key-login` 返回 404。
- `AUTH_MODE=api_key`：只展示 API Key 输入框；`/api/auth/request-otp` 与 `/api/auth/verify` 返回 404，不发验证码、不允许借此注册；`/api/auth/api-key-login` 校验服务端 `.env` 中的 256 位随机密钥，成功后复用原 `aiword_session` HttpOnly Session。
- 私有模式只绑定 `AUTH_PRIVATE_USER` 对应的一个数据库账号；该账号使用脚本预先创建，不在登录接口里自动注册。`AUTH_PRIVATE_USER` 仅用作用户标识，**不是邮箱登录地址**。
- 未知 `AUTH_MODE` 会抛错，拒绝不明确的配置。

## 1. 在干净的上游仓库安装

```bash
git clone https://github.com/leoon-hu/jiaci.git
cd jiaci
# 将这个压缩包解压，例如到 /tmp/jiaci-auth-mode-overlay
bash /tmp/jiaci-auth-mode-overlay/install.sh "$PWD"
```

安装程序会先把上游原始 `src/app/login/page.tsx` 保存为 `src/app/login/EmailLoginPage.tsx`，再覆盖两个 OTP 接口、新增私有登录接口和登录页面选择器。**如果以前已经安装过只有密码登录的旧补丁，必须重新从上游干净仓库开始**，否则无法恢复原版邮箱界面。

原有业务 API、Prisma 数据结构不需要迁移或改动。

## 2. 初始化 `.env`

```bash
cp .env.example .env
openssl rand -hex 32   # 生成随机 AUTH_API_KEY，复制输出
openssl rand -hex 32   # 单独生成 SESSION_SECRET
openssl rand -hex 24   # 用于 PostgreSQL 密码（保持纯十六进制避免 URL 编码问题）
```

在 `.env` 填写：

```dotenv
NODE_ENV=production
AUTH_MODE=api_key
AUTH_API_KEY=填入openssl_rand_hex_32生成的64字符密钥
AUTH_PRIVATE_USER=owner@private.invalid
SESSION_SECRET=另一组独立随机密钥
RESEND_API_KEY=
DATABASE_URL="postgresql://aiword:数据库密码@127.0.0.1:5432/aiword?schema=public"
POSTGRES_PASSWORD=数据库密码
SITE_HOST=words.example.com
SITE_URL=https://words.example.com
```

`AUTH_API_KEY` **只**能存储在服务器端环境变量中，不得使用 `NEXT_PUBLIC_` 前缀、不得写进前端页面源码或存入客户端 localStorage。生产环境必须 HTTPS；只开放 Nginx/Caddy 的 443，Node 3000 和 PostgreSQL 5432 监听本机。

`AUTH_MODE=email` 时，`AUTH_API_KEY` 与 `AUTH_PRIVATE_USER` 可留空，但邮箱登录的生产环境需要原仓库要求的邮件服务配置。

注意：修改 `.env` 后要重启 Next.js 服务，不建议直接修改线上容器环境而不重启。页面使用运行时动态渲染，所以切换模式不需要重新构建前端逻辑；若采用平台将 env 固化进构建产物，则以实际部署平台行为为准。

## 3. 初始化数据库与唯一账号

```bash
npm ci
# 可以使用现有 PostgreSQL；以下演示用 Docker 启动数据库
cp /tmp/jiaci-auth-mode-overlay/compose.db.yml ./compose.db.yml
docker compose --env-file .env -f compose.db.yml up -d
npx prisma generate
npm run db:migrate
npm run db:seed
npx tsx scripts/provision-private-user.ts
```

最后一步只确认/创建 `AUTH_PRIVATE_USER` 对应账号，不会删除现有学习数据。若你的数据库已有旧账号且希望保留旧进度，请把 `AUTH_PRIVATE_USER` 设置为旧账号的邮箱（只作为标识），不要随便改这个变量。

**新部署词典数据不会自动出现。** 按上游 README 获取 ECDICT `ecdict.csv` 至 `data/ecdict/`，运行：

```bash
npm run dict:load
npm run dict:sync
npm run wordbooks:build
npm run categories:build
```

AI 资料批量生成、发音预生成是独立步骤，见上游 README。

## 4. 安全切换认证模式，撤销旧会话

上游 Session 有长期有效期。**单纯禁用邮箱接口不会撤销之前登录过的浏览器 Session。** 因此每次在 `email`/`api_key` 之间切换认证模式，或轮换 `AUTH_API_KEY`，必须：

1. 停掉正在运行的应用或阻止新登录。
2. 修改 `.env` 中的 `AUTH_MODE` 与需要的密钥；如果切入 `api_key`，确保 `AUTH_PRIVATE_USER` 已预创建。
3. 撤销数据库中的所有 Session：

   ```bash
   CONFIRM_CLEAR_SESSIONS=YES npx tsx scripts/clear-auth-sessions.ts
   ```

4. 重启应用。旧 Cookie 此后无效，所有设备必须以当前模式重新登录。

撤销会话只删除 `session` 表数据，不删除用户、词库或学习记录。**不要期望轮换 `SESSION_SECRET` 能撤销这些随机 Session。**

## 5. 构建与启动

```bash
npm run typecheck
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
```

将 Next.js 放到 systemd/进程管理器中常驻。建议使用带 TLS 的反向代理，必须覆写 `X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto` 以避免来自客户端的伪造请求头影响登录限流和 Cookie Secure 标记。

示例 Nginx 配置（替换域名和证书，由你的环境安装证书）：

```nginx
server {
    listen 443 ssl http2;
    server_name words.example.com;
    ssl_certificate /etc/letsencrypt/live/words.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/words.example.com/privkey.pem;

    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

特别注意：原版 `/dict` 等公开词典页面无需登录。这个覆盖包只改变**认证模式**，不等于整站所有内容都不可匿名访问。若连词典页面也不希望公开，应额外使用 VPN、IP 白名单或对应用访问路径做反向代理保护。

## 6. 上线验证

用浏览器访问 `https://words.example.com/login`：私有模式只应看到一个 API Key 输入框；正常登录之后继续进入 `/home`，学习记录保存到 PostgreSQL。

以下请求均**无需提交真实密钥**：

```bash
# 私有模式下，原邮箱接口应都返回 HTTP 404
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/request-otp -H 'Content-Type: application/json' --data '{"email":"x@example.com"}'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/verify -H 'Content-Type: application/json' --data '{"email":"x@example.com","code":"000000"}'
# 在 email 模式，私有登录接口应返回 404
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/api-key-login -H 'Content-Type: application/json' --data '{"apiKey":"invalid"}'
```

私有模式下将错误密钥提交给 `/api/auth/api-key-login` 应返回 401；正确密钥应返回 200 并设置 HttpOnly 会话 Cookie。不要将真正的密钥直接写在终端命令行（shell history）、URL query 参数或日志中。

## 7. 限制和运维

- 此方案的“API Key”是**网页登录凭证**，不是供外部程序直接访问业务 API 的 Bearer Token。成功登录后沿用 Session Cookie。
- 单密钥、单账号；共享密钥意味着任何持有者都拥有该账号的学习数据权限。需要独立用户和权限时改成数据库用户/多令牌管理。
- `AUTH_API_KEY` 必须保密、强随机，并独立于 AI 厂商的 `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`。
- 限流使用仓库现有**单进程内存**实现，不能作为公网的唯一防护。多进程/多实例需 Redis 等共享限流，或在反向代理增加限流。
- `.env` 建议 `chmod 600 .env`，保持在 `.gitignore` 中，定期备份 PostgreSQL 和音频文件目录。
- 模式切换、轮换密钥需额外清空 Session（第 4 节）。若担心令牌泄漏，除清空会话还要立即轮换 Key。
- 并未实际测试完整上游项目的数据库与构建环境。上线前必须在你自己的环境运行 `npm run typecheck`、`npm run build` 和 E2E 登录检查。
