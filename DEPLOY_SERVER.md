# 服务器部署手册（Factory Desk V2 · Docker）

目标服务器 `43.136.121.205`，按 Ubuntu 22.04 / 24.04 编写。项目入口见 [README](README.md)，代码结构见[项目总览](docs/PROJECT_OVERVIEW.md)。不使用 Docker 的部署方式见文末[附录](#附录不用-docker-的部署pm2)。

## 整体结构

```text
浏览器 ──80/443──▶ nginx 容器 ──内部网络 backend──▶ app 容器（Node.js :8787）──▶ /data（宿主机目录）
                   （唯一对外入口）     （internal，不通外网）      （非 root、只读文件系统）
```

| 组件 | 说明 |
| --- | --- |
| `docker-compose.yml` | 定义 `app`、`nginx` 两个服务，以及按需使用的 `certbot` |
| `Dockerfile` | 两阶段构建：先装依赖并打包前端，运行镜像只含生产依赖、服务端代码和前端产物，以 `node` 用户（uid 1000）运行 |
| `deploy/nginx-factory-zones.conf` | 限流区：登录每 IP 每分钟 10 次，其他接口每 IP 每秒 20 次 |
| `deploy/nginx-factory-common.conf` | 安全响应头（含 CSP）、gzip、代理设置、请求体限制（一般 2 MB，备份上传 100 MB）、禁止访问隐藏文件 |
| `deploy/docker/nginx-site-http.conf` / `nginx-site-https.conf` | 站点模板（IP 访问用 HTTP 版，有证书后用 HTTPS 版） |
| `deploy/factory.env.example` | 敏感配置模板 |

服务器上的目录（`FACTORY_HOME`，默认 `/opt/factory-desk`）。除 `current/` 外，更新代码时都不会被覆盖：

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `current/` | 项目代码（含 `docker-compose.yml`），每次发布替换 | root |
| `factory.env` | 管理员初始密码等敏感配置 | `600` |
| `nginx-site.conf` | 当前启用的 Nginx 站点（从 `deploy/docker/` 复制并修改） | `644` |
| `data/` | 业务库、账号库、应用内备份、整机备份 `offsite/` | 属主 uid 1000，`700` |
| `letsencrypt/conf`、`letsencrypt/www` | 证书、证书验证目录 | root |
| `logs/nginx/` | Nginx 访问 / 错误日志 | root |

安全设计要点：

- 只有 nginx 容器映射端口（80/443）。app 容器**不映射任何端口**，只在内部网络 `backend` 上，而且这个网络不通外网。
- app 容器以非 root 用户运行，根文件系统只读（仅 `/data` 和 `/tmp` 可写），去掉全部 Linux 特权，禁止提权，内存上限 768 MB。
- app 只信任 nginx 容器（固定地址 `172.31.240.10`）传来的真实 IP。内部网络上的其他容器伪造 IP 头无法绕过登录限流（已实测）。

## 上线前必须完成（安全清单）

- [ ] 云服务器**安全组**只放行 22（限制为你自己的 IP）、80、443。Docker 映射的端口会绕过 ufw，所以安全组是真正的边界；本方案只映射 80/443。
- [ ] SSH 只允许密钥登录，禁止密码登录和 root 直接登录，启用 fail2ban。
- [ ] `factory.env` 中设置独立的强管理员密码。生产环境用默认值、占位符或少于 10 位的密码会拒绝启动。
- [ ] 尽快启用 HTTPS（第 7 步）。只用 HTTP 时，登录密码和登录凭证都以明文在网络上传输。
- [ ] 不要把普通用户加入 `docker` 组（等同 root 权限），也不要把 Docker 的管理端口暴露到网络上。
- [ ] 每位员工单独建账号；配置整机备份并定期拷到服务器以外（第 9 步），上线前做一次恢复演练。

## 1. 系统准备

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl tar ufw fail2ban unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades       # 自动安装系统安全更新
```

SSH 加固（**先确认已能用密钥登录**再改，以免把自己锁在外面）：

```bash
sudo nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin prohibit-password      # 或 no
sudo systemctl restart ssh
sudo systemctl enable --now fail2ban
```

防火墙。ufw 主要保护宿主机自身的服务（如 SSH）；Docker 映射的端口不受 ufw 控制，由安全组把关：

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. 安装 Docker

按 Docker 官方文档安装 Docker Engine 和 compose 插件（Ubuntu 的 apt 仓库方式），完成后确认版本：

```bash
docker --version
docker compose version
```

如果服务器在中国大陆，安装源和 Docker Hub 拉取镜像可能很慢或失败。可以改用云服务商提供的 Docker 软件源和**镜像加速地址**（以云服务商文档为准），写入 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://<云服务商提供的镜像加速地址>"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
```

```bash
sudo systemctl restart docker
```

## 3. 目录与敏感配置

```bash
sudo mkdir -p /opt/factory-desk/{current,data,letsencrypt/conf,letsencrypt/www,logs/nginx}
sudo chown 1000:1000 /opt/factory-desk/data && sudo chmod 700 /opt/factory-desk/data
```

上传代码。在开发电脑上执行：

```bash
npm run package:server                               # 生成 release/factory-desk-v2.tar.gz（已排除私密文件）
scp release/factory-desk-v2.tar.gz 你的用户@43.136.121.205:/tmp/
```

在服务器上：

```bash
sudo tar xzf /tmp/factory-desk-v2.tar.gz -C /opt/factory-desk/current

sudo cp /opt/factory-desk/current/deploy/factory.env.example /opt/factory-desk/factory.env
sudo chmod 600 /opt/factory-desk/factory.env
openssl rand -base64 18                              # 生成一个强密码
sudo nano /opt/factory-desk/factory.env              # 填入 FACTORY_ADMIN_PASSWORD

sudo cp /opt/factory-desk/current/deploy/docker/nginx-site-http.conf /opt/factory-desk/nginx-site.conf
```

- `FACTORY_ADMIN_PASSWORD` 只在管理员账号**还不存在**时用来创建账号；之后改密码请在“用户管理”里重置。
- `factory.env` 中的数据目录、监听地址等项会被 `docker-compose.yml` 覆盖，不需要改。

## 4. 构建并启动

```bash
cd /opt/factory-desk/current
sudo docker compose build                            # 首次约 1–3 分钟
sudo docker compose up -d
sudo docker compose ps                               # app 应显示 healthy，nginx 为 Up
sudo docker compose logs --tail 30 app
curl http://127.0.0.1/api/health                     # {"ok":true,"storageMode":"shared"}
```

中国大陆服务器构建时 npm 下载慢，可以指定国内 npm 镜像：

```bash
sudo NPM_REGISTRY=https://registry.npmmirror.com docker compose build
```

如果 `better-sqlite3` 的预编译包下载失败，可以加 `INSTALL_BUILD_TOOLS=1`，让它在构建阶段从源码编译；或者用 `BETTER_SQLITE3_BINARY_HOST` 指定预编译包的镜像地址。

`restart: unless-stopped` 会让两个容器随 Docker 开机自动启动，不需要 PM2。

## 5. 首次登录后

1. 用 `factory.env` 里的管理员账号登录。如果页面顶部出现红色“默认密码”提醒，立即到“用户管理”重置密码。
2. 在“用户管理”中为每位员工建立个人账号（角色选普通用户），管理员账号只给负责人。
3. 在“用户管理 → 编码规则”和“对账与打印 → 修改公司抬头”中确认设置。
4. 在“备份与恢复”中确认自动备份已开启，手动做一次备份并下载。

账号安全行为：同一账号同一 IP 连续输错 5 次锁定 15 分钟（所有 IP 合计 20 次也会锁定，重启 app 容器后清零）；重置密码或停用账号后，该账号所有设备立即下线；不能停用自己或最后一个管理员。

## 6. 上线后验证

```bash
# 服务器上
sudo docker compose ps
sudo ss -ltnp | grep -E ':80 |:443 |:8787'           # 只应看到 80、443，没有 8787
sudo docker compose exec -T app node -e "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('能访问外网')).catch(()=>console.log('无法访问外网（正确）'))"

# 在你自己的电脑上
curl -I http://43.136.121.205/                       # 能看到 Content-Security-Policy、X-Frame-Options 等响应头
curl http://43.136.121.205/.env                      # 应返回 404
```

在浏览器中打开站点并登录，检查各页面是否正常；按 F12 打开控制台，确认没有 CSP 报错。

查看 `/opt/factory-desk/logs/nginx/factory-desk.access.log` 第一列的客户端 IP：

- 应该是员工真实的公网 IP。
- 如果所有请求都显示成 `172.x.0.1`，说明 Docker 的端口代理隐藏了真实 IP（常见于通过 IPv6 访问）。这时所有人共用一个登录限流计数。可在 `/etc/docker/daemon.json` 中加入 `"userland-proxy": false` 后重启 Docker，或者只通过 IPv4 访问。

## 7. HTTPS

**强烈建议上线前完成。** 证书需要绑定域名。

1. 准备一个域名，DNS 添加 A 记录指向 `43.136.121.205`。
   - 如果服务器位于中国大陆，域名需要先完成 **ICP 备案**，才能在 80/443 端口提供网站服务。境外或港澳地域的服务器不需要。具体以云服务商要求为准。
2. 申请证书。当前 HTTP 站点已经提供证书验证路径，不需要停服务：

   ```bash
   cd /opt/factory-desk/current
   sudo docker compose run --rm certbot certonly --webroot -w /var/www/letsencrypt -d 你的域名
   ```

   也可以使用云服务商免费签发的证书：把 `fullchain.pem` 和 `privkey.pem` 放到 `/opt/factory-desk/letsencrypt/conf/live/你的域名/` 下。
3. 切换到 HTTPS 站点：

   ```bash
   sudo cp deploy/docker/nginx-site-https.conf /opt/factory-desk/nginx-site.conf
   sudo sed -i 's/factory.example.com/你的域名/g' /opt/factory-desk/nginx-site.conf
   sudo docker compose up -d --force-recreate nginx
   ```

   切换后，HTTP 请求会自动 301 跳转到 HTTPS；只启用 TLS 1.2/1.3，并开启 HTTP/2。
4. 自动续期（用 certbot 申请的证书才需要）。在 root 的 crontab 中加入：

   ```bash
   sudo crontab -e
   17 3 * * 1 cd /opt/factory-desk/current && docker compose run --rm certbot renew --quiet && docker compose exec -T nginx nginx -s reload
   ```

5. HTTPS 稳定运行一段时间后，可以在 `/opt/factory-desk/nginx-site.conf` 中取消 `Strict-Transport-Security` 那一行的注释，然后执行 `docker compose exec nginx nginx -s reload`。

## 8. 日常运维

| 操作 | 命令（在 `/opt/factory-desk/current` 下） |
| --- | --- |
| 查看状态 | `sudo docker compose ps` |
| 应用日志（含内部错误详情、默认密码警告） | `sudo docker compose logs -f app` |
| Nginx 日志 | `/opt/factory-desk/logs/nginx/factory-desk.access.log`、`factory-desk.error.log` |
| 重启应用 | `sudo docker compose restart app` |
| 修改 Nginx 配置后生效 | `sudo docker compose exec nginx nginx -t && sudo docker compose exec nginx nginx -s reload` |
| 停止 / 启动全部 | `sudo docker compose down` / `sudo docker compose up -d` |

`docker compose down` 只删除容器，数据在宿主机的 `/opt/factory-desk/data`，不会丢失（已实测）。

## 9. 备份（务必做到“离开这台服务器”）

| 方式 | 内容 | 位置（宿主机） |
| --- | --- | --- |
| 应用内自动备份 | 仅业务库 | `/opt/factory-desk/data/backups` |
| 整机备份 | 业务库 + 账号库 + 备份设置 + 校验值 | `/opt/factory-desk/data/offsite/日期时间/` |

每天凌晨在容器内执行整机备份（服务运行中执行也安全）：

```bash
sudo crontab -e
30 2 * * * cd /opt/factory-desk/current && docker compose exec -T -e FACTORY_OFFSITE_KEEP=30 app node scripts/full-backup.mjs >> /opt/factory-desk/logs/backup.log 2>&1
```

再把 `/opt/factory-desk/data/offsite` 定期同步到**另一台机器或对象存储**，例如在另一台机器上执行：

```bash
rsync -az --delete 你的用户@43.136.121.205:/opt/factory-desk/data/offsite/ ~/factory-desk-backups/
```

也可以给云硬盘开启定期快照。

恢复演练（建议每月一次，在测试环境进行）：

1. 新建一个测试目录，按第 3、4 步搭好环境。
2. 把备份目录里的 `factory-desk.db`、`auth.db` 分别放到测试目录的 `data/business/`、`data/auth/` 下（属主 uid 1000）。
3. 启动后确认能登录、数据完整。`sha256sum -c SHA256SUMS` 可以校验备份文件的完整性。

业务数据也可以在“备份与恢复”页面上传 `.db` 文件后恢复。

## 10. 更新发布与回滚

```bash
cd /opt/factory-desk/current
sudo docker compose exec -T app node scripts/full-backup.mjs          # 更新前先做整机备份
sudo docker tag factory-desk-app:latest factory-desk-app:previous     # 保留当前镜像以便回滚
sudo tar xzf /tmp/factory-desk-v2.tar.gz -C /opt/factory-desk/current
sudo docker compose build app
sudo docker compose up -d                                            # 自动用新镜像重建 app，并按需重建 nginx
sudo docker compose ps && sudo docker compose logs --tail 30 app
```

- 如果新版本修改了 `deploy/docker/nginx-site-*.conf`，需要对照修改 `/opt/factory-desk/nginx-site.conf`。限流区和公共片段直接从代码目录挂载，执行 `docker compose up -d --force-recreate nginx` 即可生效。
- 回滚到上一版：`sudo docker tag factory-desk-app:previous factory-desk-app:latest && sudo docker compose up -d --no-build`。如果数据也需要回退，用更新前的整机备份恢复。
- 定期执行 `sudo docker compose pull nginx && sudo docker compose up -d nginx`，获取 Nginx 镜像的安全更新；应用基础镜像的更新随下次 `docker compose build --pull` 获取。

## 11. 清空业务数据（仅测试阶段）

首次启动即为空库。如需在正式使用前清掉测试数据：管理员在“用户管理”中执行“清空业务数据”。操作前会自动保存保护备份，账号与编号设置保留。

## 可选构建与运行参数

均在执行 `docker compose` 命令时作为环境变量传入，例如 `sudo NPM_REGISTRY=... docker compose build`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FACTORY_HOME` | `/opt/factory-desk` | 服务器专属文件所在目录 |
| `NODE_IMAGE` | `node:22-bookworm-slim` | 应用基础镜像 |
| `NGINX_IMAGE` | `nginx:stable-alpine` | Nginx 镜像（需 ≥ 1.25.1，支持 `http2 on`） |
| `NPM_REGISTRY` | 官方 npm | 构建时的 npm 源 |
| `INSTALL_BUILD_TOOLS` | `0` | 设为 `1` 时安装编译工具，用于 `better-sqlite3` 源码编译 |
| `APP_VERSION` | `latest` | 应用镜像标签 |

网络环境使用自签名或企业代理证书时，可以用构建密钥传入额外的 CA：`docker build --secret id=extra_ca,src=证书文件 ...`。

内部网络固定使用 `172.31.240.0/24` 网段（nginx 为 `.10`，app 为 `.20`）。如果和服务器上已有的网络冲突，需要同时修改 `docker-compose.yml` 中的网段、两个固定地址，以及 `FACTORY_TRUSTED_PROXIES`。

## 附录：不用 Docker 的部署（PM2）

也可以直接在宿主机运行：

1. 安装 Node.js 22 和 PM2，以专用用户 `factory` 运行。
2. 敏感配置同样写在 `/opt/factory-desk/factory.env`，由 `ecosystem.config.cjs` 读取。
3. Node 固定监听 `127.0.0.1:8787`。
4. Nginx 安装在宿主机上，使用以下配置：
   - `deploy/nginx-factory-zones.conf` → `/etc/nginx/conf.d/`
   - `deploy/nginx-factory-common.conf` → `/etc/nginx/snippets/factory-desk-common.conf`
   - `deploy/nginx-factory.conf` 或 `deploy/nginx-factory-https.conf` → `/etc/nginx/sites-available/factory-desk`

   这里的站点文件把上游指向 `127.0.0.1:8787`。
5. 启动：`npm ci --include=dev && npm run build`，然后 `pm2 start ecosystem.config.cjs`。整机备份用 `npm run backup:full`。

两种方式只能选一种，不要同时运行，否则会争用 80 端口和数据库。

## 历次更新须知

- **2026-10-05（Docker）**：
  - 改为 Docker Compose 部署，Nginx 也在容器中。
  - 新增 `FACTORY_TRUSTED_PROXIES`，用来指定可信的反向代理地址。
  - Nginx 公共片段改用上游 `factory_app`，具体地址由站点文件定义。
- **2026-10-05**：
  - Node 默认只监听 `127.0.0.1`。
  - 敏感配置独立存放到 `factory.env`。
  - Nginx 增加限流、安全头、CSP、HTTPS 模板。
  - 新增整机备份脚本。
  - 生产环境拒绝用默认密码创建管理员。
  - 默认不再发送跨域头（`FACTORY_CORS_ORIGIN`）。
- **2026-09-30**：
  - 出入库必须对应已有客户档案。
  - 物料修改接口不再改库存，期初库存用盘点录入。
  - 首次启动旧库前自动保存保护副本。

更多业务规则见[业务操作说明](docs/BUSINESS_WORKFLOWS.md)，账号与会话说明见[登录与存储](docs/LOGIN_AND_STORAGE.md)。
