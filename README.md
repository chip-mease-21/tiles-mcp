# Tiles MCP Server — connect Tiles to Meta Muse (or any MCP client)

This is a small server that lets **Meta Muse** (or Claude, ChatGPT, Cursor — anything
that speaks MCP) read and write your **Tiles** board. Your data stays in your existing
Tiles Firestore database — this server is just a secure bridge.

It exposes these tools: `list_tiles`, `get_tile`, `create_tile`, `update_tile`,
`move_tile`, `add_task`, `set_task_done`, `delete_tile`, `list_tags`.

---

## Before you start — what you'll need
1. Your existing **Tiles Firebase project** (`tiles-4972a`).
2. A place to host this server (free: **Render.com**; alternatives: Railway, Fly.io).
3. **Meta Muse** with the ability to add a **custom connector** (see the caveat in step 5).

> ⚠️ **Security:** this server uses a Firebase *service account*, which has broad access
> to your project, and it can read/write your whole board. It is protected by one secret
> token. **Anyone who has the server URL and the token has full access to your tiles** —
> keep the token private, and never commit the service-account key to a public repo.

---

## Step 1 — Create a Firebase service-account key
1. Firebase console → your project → **⚙ Project settings → Service accounts**.
2. Click **Generate new private key** → **Generate key**. A `.json` file downloads.
3. Keep this file safe. You'll paste its contents into the host in step 4. Do **not**
   commit it to GitHub.

## Step 2 — Find your Tiles user id
1. Firebase console → **Authentication → Users**.
2. Find your row (chip@thepointcville.com) and copy the **User UID** (a long string).
   This is `TILES_USER_ID`.

## Step 3 — Make a secret token
Generate a long random string (e.g. run `openssl rand -hex 24` in Terminal, or use any
password generator). This is `MCP_AUTH_TOKEN`. Save it — Muse will need it.

## Step 4 — Deploy the server (Render, free)
1. Put this folder in a **new GitHub repo** (e.g. `tiles-mcp`). From this folder:
   ```bash
   git init
   git add -A
   git commit -m "Tiles MCP server"
   git branch -M main
   git remote add origin https://github.com/<you>/tiles-mcp.git
   git push -u origin main
   ```
   (The included `.gitignore` keeps `node_modules` and `.env` out of the repo.)
2. Go to **render.com** → **New → Web Service** → connect the `tiles-mcp` repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Add **Environment Variables**:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` → paste the **entire contents** of the `.json` file
     from step 1 (all on one line is safest — open it in a text editor and copy everything).
   - `TILES_USER_ID` → the UID from step 2.
   - `MCP_AUTH_TOKEN` → the secret from step 3.
5. Deploy. Render gives you a URL like `https://tiles-mcp.onrender.com`.
   - Your **MCP endpoint** is that URL **+ `/mcp`**, e.g.
     `https://tiles-mcp.onrender.com/mcp`.
   - Visit the base URL in a browser — it should say "Tiles MCP server is running."
   - Note: Render's free tier sleeps after inactivity, so the first request after a while
     can take ~30–60 seconds to wake up.

## Step 5 — Add it to Meta Muse
In Muse's connector settings, add a **custom connector** with:
- **Type:** MCP server (Streamable HTTP)
- **URL:** `https://<your-host>/mcp`
- **Authentication:** header `Authorization` with value `Bearer <MCP_AUTH_TOKEN>`

> Caveat: as of late 2026, Muse's *custom* MCP connectors are developer-oriented and the
> exact setup screen may differ or be gated. Muse's built-in connectors (Gmail, Calendar,
> etc.) are the well-paved path; custom MCP is newer. If Muse can't add a custom MCP
> endpoint yet, the server is still ready — you can point Claude, Cursor, or any MCP
> client at the same URL + token in the meantime.

---

## Test it locally (optional)
```bash
npm install
cp .env.example .env        # fill in the three values
npm start                   # http://localhost:3000
```
Then from an MCP client, or a quick curl handshake:
```bash
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## What Muse will be able to say/do (examples)
- "What's due this week in Tiles?" → `list_tiles` (column `this_week`, or `due_on_or_before`)
- "Add a to-do to Inbox: call the printer, due Friday" → `create_tile`
- "Check off 'Send to Carolyn' on the Gabe's Salary tile" → `set_task_done`
- "Move the Board Report tile to Today" → `move_tile`
- "What tags do I have?" → `list_tags`

## Notes / limits
- Writes here appear in your Tiles app instantly (same Firestore), and vice versa.
- `position` for new tiles is set to "now" so they land at the bottom of a column.
- For tighter security you can create a dedicated service account limited to Cloud
  Firestore instead of using the default one.
