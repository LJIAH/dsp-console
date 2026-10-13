#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# dsp-console 一键部署：拉取 → 安装 → 构建 → 常驻 → 自检
#
# 在你自己的电脑上执行（Git Bash / macOS / Linux，仓库根目录）：
#   ssh root@8.138.193.49 "bash -s" < deploy/deploy.sh
# 在服务器上执行（宝塔终端 / SSH，之后更新也跑它）：
#   bash /www/wwwroot/dsp.kevy.top/deploy/deploy.sh
#
# 可用环境变量（都有默认值，一般不用动）：
#   APP_DIR      代码目录   默认 /www/wwwroot/dsp.kevy.top（= 宝塔给该域名建的站点目录）
#   REPO_URL     仓库地址   默认 https://github.com/LJIAH/dsp-console.git
#                           clone 慢/超时可换镜像，例如 Gitee 或
#                           https://ghfast.top/https://github.com/LJIAH/dsp-console.git
#   BRANCH       分支       默认 main
#   PORT         网关端口   默认 5090（要与宝塔反代的目标端口一致）
#   DOMAIN       域名       默认 dsp.kevy.top（只用于打印提示）
#   NO_SERVICE=1 只拉代码 + 构建，不碰 systemd（本机冒烟、或用宝塔「Node 项目」时）
#
# 脚本不管的三件事（属于面板/安全组，只做一次；跑完它会打印具体怎么配）：
#   ① 域名解析 + 宝塔里配好 HTTPS 证书
#   ② nginx 把 / 反代到 http://127.0.0.1:<PORT>（含 WebSocket 的三行头）
#      宝塔有「反向代理」入口就用；没有（阿里云定制版等精简版）就贴站点「配置文件」里的
#      `location ^~ /` —— 注意 `^~` 与 `Host $host` 两个都不能省，原因见脚本结尾的打印
#   ③ 安全组放行 80/443；5090 只在同机反代，不必对外开放
#
# ⚠️ 代码目录 = 站点目录，所以**反向代理必须配好**：
#    配好之后 / 全部转给 Node（Node 只发 dist/，仓库源码不会外泄）；
#    万一没配，nginx 会直接按站点根目录发文件（宝塔默认拦了 .git/.env，但 src/、server/ 是发得出去的）。
#
# 脚本内部的 git 调用都带 `-c safe.directory=<APP_DIR>`（站点目录属主是 www、脚本是 root，
# 否则 git 会报 "detected dubious ownership"）。你自己想在这个目录里敲 git（status/pull）时，
# 要么每次加 `-c safe.directory=...`，要么一次性放开（你自己的机器，自己决定）：
#   git config --global --add safe.directory /www/wwwroot/dsp.kevy.top
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_NAME=dsp-console
APP_DIR=${APP_DIR:-/www/wwwroot/dsp.kevy.top}
REPO_URL=${REPO_URL:-https://github.com/LJIAH/dsp-console.git}
BRANCH=${BRANCH:-main}
PORT=${PORT:-5090}
DOMAIN=${DOMAIN:-dsp.kevy.top}
NO_SERVICE=${NO_SERVICE:-0}
SERVICE=/etc/systemd/system/$APP_NAME.service
NODE_MIN_MAJOR=22

say() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── ① 环境检查 ────────────────────────────────────────────────────
say "① 环境检查"
command -v git >/dev/null 2>&1 || die "没装 git。宝塔「软件商店」搜 git 装上，或 apt/yum install git"
command -v curl >/dev/null 2>&1 || die "没装 curl（宝塔节点一般自带；apt/yum install curl）"

node_major() { "$1" -v 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p'; }

# Node 候选：优先宝塔的 Node 版本管理器（面板可管），再取 PATH 里的，取版本最高的那个
find_node() {
  local candidates=() best='' best_major=0 c major
  for c in /www/server/nodejs/v*/bin/node; do
    [ -x "$c" ] && candidates+=("$c")
  done
  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  [ -x /usr/local/bin/node ] && candidates+=("/usr/local/bin/node")
  for c in ${candidates[@]+"${candidates[@]}"}; do
    major=$(node_major "$c") || continue
    [ -n "$major" ] || continue
    if [ "$major" -gt "$best_major" ]; then best="$c"; best_major="$major"; fi
  done
  [ -n "$best" ] && printf '%s' "$best"
}

NODE_BIN=$(find_node || true)
if [ -z "${NODE_BIN:-}" ] || [ "$(node_major "$NODE_BIN")" -lt "$NODE_MIN_MAJOR" ]; then
  say "当前 Node：${NODE_BIN:-未安装}（需要 ≥ v$NODE_MIN_MAJOR —— 网关用 import attributes 读 JSON 契约）"
  cat <<'TIP'
  两种装法，装完重跑本脚本即可（脚本会自动认宝塔装的那个）：
    A. 宝塔面板：软件商店 → Node.js 版本管理器 → 安装 v22（推荐，面板可管理）
    B. 命令行  ：curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
TIP
  die "Node 版本不满足"
fi
ok "Node $("$NODE_BIN" -v)  →  $NODE_BIN"
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [ "$NO_SERVICE" != "1" ]; then
  [ "$(id -u)" = "0" ] || die "写 systemd 需要 root（用 sudo，或 NO_SERVICE=1 只构建）"
  command -v systemctl >/dev/null 2>&1 || die "没有 systemd（本机冒烟请加 NO_SERVICE=1）"
fi

# ── ② 取代码 ──────────────────────────────────────────────────────
say "② 取代码 → $APP_DIR"
mkdir -p "$APP_DIR"
# 站点目录可能属于 www、而脚本以 root 身份跑 → 显式声明为安全目录，
# 免得 git 报 "detected dubious ownership"（只影响这一次调用，不改全局配置）
gitc=(git -c "safe.directory=$APP_DIR" -C "$APP_DIR")

if [ ! -d "$APP_DIR/.git" ]; then
  [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ] &&
    say "  目录里已有文件（宝塔站点默认的 index.html 之类）→ 就地 git init，不删任何东西"
  "${gitc[@]}" init -q
  "${gitc[@]}" remote remove origin >/dev/null 2>&1 || true
  "${gitc[@]}" remote add origin "$REPO_URL"
fi

"${gitc[@]}" fetch --depth 1 origin "$BRANCH"
# 部署目录就该跟着仓库走：受版本控制的文件会被覆盖成本次的提交（这正是"部署"的语义）。
# 未跟踪的既有文件（宝塔的 index.html、dist/、node_modules/）不受影响。
"${gitc[@]}" reset --hard FETCH_HEAD
# ⚠️ 这里的 git 调用也必须走 ${gitc[@]}（带 safe.directory）—— 裸 git -C 会报
#    "detected dubious ownership"（站点目录属主是 www，脚本以 root 跑）
ok "当前版本 $("${gitc[@]}" log -1 --format='%h %s')"

# ── ③ 安装依赖 + 构建 ─────────────────────────────────────────────
say "③ 安装依赖 + 构建（产物 dist/ 由网关自己托管，前后端同源）"
cd "$APP_DIR"
# --prefer-frozen-lockfile：锁文件能对上就不动它，对不上则按 package.json 修正 —— 部署不该因此失败
command -v pnpm >/dev/null 2>&1 || {
  say "  没装 pnpm，先装：npm i -g pnpm"
  npm install -g pnpm >/dev/null 2>&1 || die "pnpm 安装失败（可试 corepack enable）"
}
pnpm install --prefer-frozen-lockfile
pnpm build
[ -f dist/index.html ] || die "构建没有产出 dist/index.html —— 看上面的报错"
ok "构建完成：$(du -sh dist | cut -f1) dist/"

# ── ④ 常驻（systemd） ─────────────────────────────────────────────
if [ "$NO_SERVICE" = "1" ]; then
  say "④ 跳过 systemd（NO_SERVICE=1）—— 自己起进程： PORT=$PORT node server/index.mjs"
else
  say "④ 写入 systemd 单元并启动"
  cat >"$SERVICE" <<EOF
[Unit]
Description=$APP_NAME（Mock 设备网关 + 前端静态站点）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server/index.mjs
Environment=NODE_ENV=production
Environment=PORT=$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
  systemctl restart "$APP_NAME"
  ok "systemctl enable --now $APP_NAME（开机自启、崩溃自拉）"
fi

# ── ⑤ 自检 ────────────────────────────────────────────────────────
if [ "$NO_SERVICE" = "1" ]; then
  say "⑤ 已跳过自检（NO_SERVICE=1 没有起进程）"
else
  say "⑤ 自检：http://127.0.0.1:$PORT/healthz"
  health=''
  for _ in $(seq 1 10); do
    if health=$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null); then break; fi
    sleep 1
  done
  if [ -n "$health" ]; then
    ok "$health"
  else
    say "没起来，最近 30 行日志："
    journalctl -u "$APP_NAME" -n 30 --no-pager || true
    die "健康检查失败"
  fi
fi

cat <<EOF

══════════════════════════════════════════════════════════════════
✅ 部署完成

  网关（含前端静态文件）  http://127.0.0.1:$PORT
  健康检查                http://127.0.0.1:$PORT/healthz
  实时日志                journalctl -u $APP_NAME -f
  更新代码                重跑本脚本（拉取 → 构建 → 重启，一条龙）

接下来只剩 nginx 那一层：把 $DOMAIN 交给 $PORT（宝塔里做一次即可）

  A. 站点设置里**有**「反向代理」：
     添加 → 目标 URL http://127.0.0.1:$PORT、发送域名 \$host
  B. **没有**（阿里云定制版等精简版：站点设置只有 域名管理/流量限制/伪静态/配置文件/
     重定向/SSL/网站日志）：点站点「配置文件」，把下面这段贴进 server{} ——
     原来若已有 location /，就整段替换（别并存两个）：

      location ^~ / {
          proxy_pass http://127.0.0.1:$PORT;
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;      # ← Origin 校验靠它（网关只放行同源）
          proxy_set_header X-Real-IP \$remote_addr;
          proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
          proxy_read_timeout 3600s;
          proxy_send_timeout 3600s;
      }

  ⚠️ 三个坑（都是真踩过的）：
     · ^~ 不能省：nginx 里正则 location 优先级高于普通前缀，模板自带的
       「location ~* \.(js|css)\$」会把 /assets/* 抢走 → 白屏（静态文件它去站点根目录找）
     · Host \$host 不能省：网关只放行同源 Origin，缺它 → 403、顶栏一直连不上
     · 「网站 → 伪静态」设成 默认/空，免得它再往里塞 rewrite

  安全组：放行 80/443 即可；$PORT 只在同机反代，不必对外开放。

验收：
  curl -s https://$DOMAIN/healthz     # → {"ok":true,...,"devices":10}
  浏览器打开 https://$DOMAIN          # 顶栏「已连接」，点两下故障注入台
  journalctl -u $APP_NAME -f          # 刷新页面应看到「客户端已连接 → 推送快照」
══════════════════════════════════════════════════════════════════
EOF
