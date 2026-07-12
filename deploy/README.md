# Deployment (Oracle Cloud Free Tier)

One-time server bootstrap on the `app-vm` (Ubuntu 22.04, Ampere A1):

```bash
# Node 18 LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2

# clone + first install
sudo mkdir -p /opt/wa-b-2.0 && sudo chown $USER:$USER /opt/wa-b-2.0
git clone https://github.com/Des-ync/wa-b-2.0.git /opt/wa-b-2.0
cd /opt/wa-b-2.0
npm ci --omit=dev
cp .env.example .env   # then fill in real values, DATABASE_URL pointing at db-vm private IP

npm run migrate
npm run seed
npm run issue-key admin "ops"

pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup   # run the printed command to enable boot-time start

# nginx + TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wa-saas
sudo sed -i 's/yourdomain.me/YOUR_REAL_DOMAIN/' /etc/nginx/sites-available/wa-saas
sudo ln -s /etc/nginx/sites-available/wa-saas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_REAL_DOMAIN
```

## GitHub Actions secrets

Set these in the repo (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ORACLE_APP_HOST` | Public IP or domain of `app-vm` |
| `ORACLE_APP_USER` | SSH user (e.g. `ubuntu`) |
| `ORACLE_APP_SSH_KEY` | Private key matching a public key in `~/.ssh/authorized_keys` on `app-vm` |

Every push to `main` then runs `.github/workflows/deploy.yml`: pulls latest, installs deps, runs migrations, and does a zero-downtime `pm2 reload`.

## Database VM (`db-vm`)

```bash
sudo apt-get install -y postgresql
sudo -u postgres createuser --pwprompt wa_saas
sudo -u postgres createdb -O wa_saas whatsapp_saas
# in pg_hba.conf, allow only app-vm's private IP; in postgresql.conf, listen_addresses = '<db-vm private IP>'
sudo systemctl restart postgresql
```

Use the resulting private-IP connection string as `DATABASE_URL` on `app-vm`.
