# OkiMAP collaboration API

GitHub Pages側から利用する、ラズパイ常駐の共有ピンAPIです。外部公開はCloudflare Tunnelを使用し、API本体はラズパイの`127.0.0.1:8780`だけで待ち受けます。DiscordのClient Secret、セッション署名鍵、管理者Discord IDはラズパイだけに保存します。

Python 3.10以上と、Cloudflare Tunnelを前提にしています。

## 初回配置

```bash
sudo useradd --system --home /opt/okimap-api --shell /usr/sbin/nologin okimap
sudo mkdir -p /opt/okimap-api /var/lib/okimap-api
sudo chown -R okimap:okimap /opt/okimap-api /var/lib/okimap-api

sudo -u okimap python3 -m venv /opt/okimap-api/.venv
sudo -u okimap /opt/okimap-api/.venv/bin/pip install -r /opt/okimap-api/requirements.txt
```

`server/`内のファイルを`/opt/okimap-api`へ配置します。実設定はGitへ含めず、次のように作成します。

```bash
sudo cp /opt/okimap-api/okimap-api.env.example /etc/okimap-api.env
sudo chown root:root /etc/okimap-api.env
sudo chmod 600 /etc/okimap-api.env
sudo nano /etc/okimap-api.env
```

`DISCORD_CLIENT_SECRET`、`OKIMAP_SESSION_SECRET`、`OKIMAP_ADMIN_DISCORD_IDS`を設定してください。`OKIMAP_SESSION_SECRET`は次のように生成できます。

ローカルのGitHub Pages確認用サーバーから接続する場合は、`OKIMAP_ALLOWED_ORIGINS`へカンマ区切りでそのoriginを追加し、ローカルHTTPでは`OKIMAP_SECURE_COOKIES=false`を使用します。本番では必ず`true`に戻してください。

## Discord設定

Discord Developer PortalのOAuth2 Redirectsへ次を登録します。

```text
https://okimap-api.wplaceoki.com/api/auth/discord/callback
```

OAuth2 scopeは`identify`だけを使用します。Discordサーバー在籍確認は現時点では行いません。

## systemd

`okimap-api.service`を`/etc/systemd/system/`へ配置します。

```bash
sudo cp /opt/okimap-api/okimap-api.service /etc/systemd/system/okimap-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now okimap-api
```

ラズパイ内部での疎通確認:

```bash
curl http://127.0.0.1:8780/api/health
```

## Cloudflare Tunnel

Cloudflare Dashboardで、既存TunnelへPublished applicationを1件追加します。

```text
Hostname:    okimap-api.wplaceoki.com
Path:        空欄
Type:        HTTP
Service URL: http://127.0.0.1:8780
```

`localhost`でも動く場合がありますが、APIはIPv4の`127.0.0.1`にだけバインドしているため、`127.0.0.1`を明示します。HTTP Hostヘッダー、チャンクエンコーディング、接続／キープアライブ、Access JWT検証はデフォルト設定のままで構いません。Access JWT検証はオンにしません。公開閲覧を許可し、投稿の認証はアプリ内のDiscord OAuthで行うためです。

公開後の疎通確認:

```bash
curl https://okimap-api.wplaceoki.com/api/health
```

CloudflaredのTunnel Tokenをコマンド引数、リポジトリ、スクリーンショットに残さないでください。TokenはCloudflare側で管理し、ラズパイ上ではroot以外が読めないsystemd設定またはEnvironmentFileを使用します。

## テスト

依存関係を入れた仮想環境で、SQLite・CORS・認証必須操作・本人／管理者権限・コメントAPIを確認できます。

```bash
cd /opt/okimap-api
.venv/bin/python test_app.py
```

## バックアップ

SQLiteはWALモードで動作します。稼働中の安全なバックアップには次を使用します。

```bash
sqlite3 /var/lib/okimap-api/okimap.db ".backup '/path/to/backup/okimap-$(date +%F).db'"
```

APIは単一Uvicornワーカーで起動してください。投稿頻度制限はプロセス内で管理されます。
