# J Michael's Marketing HQ — Deploy Guide

## What you're deploying
- **Frontend** → Cloudflare Pages (auto-deploys from GitHub)
- **API Worker** → Cloudflare Workers (handles all data)
- **Database** → Cloudflare D1 (SQLite, all users/posts/scores/reminders)

---

## Step 1 — Push to GitHub

1. Create a new GitHub repo called `jmichaels-marketing`
2. Upload the entire contents of this folder:
   ```
   frontend/   ← goes to repo root
   worker/     ← goes to repo root
   ```
3. Your repo structure should look like:
   ```
   /
   ├── index.html
   ├── wrangler.toml          (frontend)
   ├── worker/
   │   ├── index.js
   │   ├── schema.sql
   │   └── wrangler.toml
   ```

---

## Step 2 — Create the D1 Database

In Cloudflare Dashboard → **Workers & Pages** → **D1**:

1. Click **Create database**
2. Name it: `jmichaels-db`
3. Copy the **Database ID** (you'll need it next)

Then open `worker/wrangler.toml` and paste your Database ID:
```toml
database_id = "PASTE_YOUR_ID_HERE"
```

---

## Step 3 — Deploy the Worker API

Install Wrangler if you haven't:
```bash
npm install -g wrangler
wrangler login
```

Then from the `worker/` folder:
```bash
cd worker

# Run the schema to create all tables + seed admin user
wrangler d1 execute jmichaels-db --file=schema.sql

# Deploy the worker
wrangler deploy
```

After deploy, copy your Worker URL — it will look like:
```
https://jmichaels-marketing-api.YOUR_SUBDOMAIN.workers.dev
```

---

## Step 4 — Update the Frontend API URL

Open `frontend/index.html` and find line ~3 of the script:
```javascript
const API = 'https://jmichaels-marketing-api.YOUR_SUBDOMAIN.workers.dev';
```
Replace with your actual Worker URL. Push to GitHub.

---

## Step 5 — Deploy Frontend to Cloudflare Pages

1. In Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages**
2. Connect your GitHub repo
3. Settings:
   - **Build command**: (leave empty)
   - **Build output directory**: `/` (root)
   - **Root directory**: `/frontend`
4. Click **Save and Deploy**

Your URL will be: `https://jmichaels-marketing.pages.dev`

---

## Default Login
- **Username**: `admin`
- **Password**: `jmichaels2024`

**Change this immediately** — go to Users & Invites → Change my password.

---

## Notes
- The Worker API handles all auth, data, and user management
- All data lives in Cloudflare D1 — shared across all users
- Sessions last 30 days; tokens stored in localStorage
- Free tier limits: D1 = 5GB storage, 25M reads/day — more than enough
- To add staff: Users & Invites → Generate invite code → share the code
