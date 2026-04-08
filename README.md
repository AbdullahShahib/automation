# 🚀 AgencyFlow — Automation Platform for Digital Agencies

A complete automation platform inspired by n8n, built specifically for your digital agency. Finds clients, sends cold emails, auto-replies to messages and contact forms, manages leads in a CRM, and logs everything to Excel or Google Sheets.

---

## ✨ Features

| Feature | Status |
|---|---|
| 🔧 Visual Workflow Builder (drag & drop) | ✅ |
| 🧠 AI-powered (OpenRouter/Groq/Anthropic) email/pitch generation | ✅ |
| 📧 Gmail/SMTP cold email sending | ✅ |
| 💬 Message auto-reply (Telegram free / Twilio optional) | ✅ |
| 🌐 Contact form webhook handler | ✅ |
| 🎯 AI lead prospecting by niche | ✅ |
| 📊 Excel + Google Sheets integration | ✅ |
| 👥 Built-in CRM with lead tracking | ✅ |
| ⏰ Scheduled workflows (cron jobs) | ✅ |
| 🔔 Slack + WhatsApp notifications | ✅ |
| { } Custom JavaScript logic nodes | ✅ |
| 🌐 HTTP Request node (any API) | ✅ |
| 📋 Execution logs (real-time) | ✅ |
| 💾 CSV export | ✅ |

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Run setup wizard
```bash
npm run setup
```
This will ask for your API keys and create a `.env` file.

### 3. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### Windows one-click start/stop
From PowerShell, inside this project folder:
```powershell
.\start-local.ps1
```
Stop it with:
```powershell
.\stop-local.ps1
```

### 4. Open the dashboard
```
http://localhost:3000
```

---

## 🔑 API Keys You Need

### AI (Free Options Available)
- OpenRouter free models: https://openrouter.ai
- Groq free tier: https://console.groq.com
- Set `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in `.env`

### Gmail / SMTP (Required for email)
- Enable 2FA on your Google account
- Generate an App Password: https://myaccount.google.com/apppasswords
- Set `SMTP_USER` (your Gmail) and `SMTP_PASS` (App Password) in `.env`

### Messaging
- Free option (recommended): Telegram bot
  - Create bot via @BotFather
  - Set `MESSAGING_PROVIDER=telegram`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` in `.env`
- Optional paid option: Twilio WhatsApp
- Webhook source for message workflows:
  ```
  POST https://your-domain.com/webhook/whatsapp
  ```

### Excel (Recommended) / Google Sheets (Optional)
1. Set `EXCEL_FILE_PATH=./data/leads.xlsx` in `.env`
2. Workflow sheet nodes will read and write this file directly

Google Sheets optional setup:
1. Go to: https://console.cloud.google.com
2. Create a project → Enable "Google Sheets API"
3. Create a Service Account → Download JSON credentials
4. Save the JSON file as `data/google-credentials.json`
5. Share your Google Sheet with the service account email
6. Set your `DEFAULT_SHEET_ID` in `.env`

---

## 📡 Webhook URLs

Once running, these are your webhook endpoints:

| Integration | URL | Notes |
|---|---|---|
| Contact Form | `POST /webhook/contact_form` | Add to your portfolio HTML form action |
| WhatsApp | `POST /webhook/whatsapp` | Set in Twilio console |
| Custom | `POST /webhook/:any-name` | Create matching workflow |

### Contact Form HTML Example
```html
<form action="http://your-server:3000/webhook/contact_form" method="POST">
  <input name="name" placeholder="Your Name">
  <input name="email" type="email" placeholder="Email">
  <input name="phone" placeholder="Phone">
  <input name="budget" placeholder="Budget">
  <textarea name="message" placeholder="Message"></textarea>
  <button type="submit">Send</button>
</form>
```

---

## 🔧 Default Workflows

### 1. 🌐 Contact Form Auto-Reply
**Trigger:** Contact form submitted
**Flow:** Save Lead → AI generates reply → Send email → Log to Excel/Sheet → Notify you

### 2. 💬 WhatsApp Auto-Responder
**Trigger:** WhatsApp message received
**Flow:** AI qualifies lead → If budget > ₹30k → Premium reply, else → Basic reply → Log to CRM

### 3. 🎯 Daily Lead Prospector
**Trigger:** Every day at 9 AM
**Flow:** AI finds 10 new leads in your niche → Generate cold emails → Log to sheet → Summary to you

### 4. 📧 Cold Email Campaign
**Trigger:** Manual or webhook
**Flow:** Read leads from sheet → Generate personalized email + call script → Send → Update status

### 5. 🔄 Follow-Up Sequence
**Trigger:** Every Monday 10 AM
**Flow:** Find stale leads (not replied in 5 days) → AI follow-up email → Send → Update status

---

## 🧩 Node Types

### Triggers
- **Webhook** — fires when a POST hits `/webhook/:source`
- **Schedule** — cron-based (e.g. `0 9 * * *` = daily 9AM)
- **Manual** — triggered via API or dashboard button

### AI Nodes
- **AI Generate** — creates emails, WhatsApp messages, call scripts, contracts
- **AI Qualify** — extracts budget/intent from a message
- **AI Prospect** — generates a list of potential clients

### Communication
- **Send Email** — sends via SMTP/Gmail
- **Message Reply** — sends via Telegram (free) or Twilio
- **Notify Me** — Slack or WhatsApp notification to you

### Data
- **Save Lead** — saves to built-in CRM
- **Sheet: Add Row** — appends to Excel or Google Sheets
- **Sheet: Read** — reads rows (with filter)
- **Sheet: Update** — updates a row status

### Logic
- **Condition / If** — branch based on JavaScript expression
  - Example: `data.budget > 50000` → premium branch
- **Custom JavaScript** — run any code, return data object
- **HTTP Request** — call any external API
- **Delay** — wait N seconds

---

## 📊 Excel/Sheets Structure

When leads are logged, the sheet gets these columns:
```
Date | Business Name | Owner | Phone | Email | Address | Needs | Budget | Status | Score | Source | Notes
```

---

## 🌐 Hosting on VPS (Recommended)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone / copy your files
npm install
npm run setup

# Install PM2 for background running
npm install -g pm2
pm2 start backend/server.js --name agencyflow
pm2 save
pm2 startup

# Use Nginx for HTTPS (needed for public webhooks)
# Point your domain to VPS IP
# Install certbot for SSL
```

---

## 🔐 Security Notes

- Never commit `.env` to git (it's in `.gitignore`)
- Use HTTPS for production webhook integrations
- Keep `data/google-credentials.json` private
- The `data/` directory contains all your leads and workflow data

---

## 💡 Custom Condition Example

In a Condition node, you can write:
```javascript
// Route by budget
data.budgetNum > 50000

// Route by keyword
data.message.toLowerCase().includes('urgent')

// Route by time of day
new Date().getHours() >= 9 && new Date().getHours() < 18

// Always true
true
```

In a JavaScript node:
```javascript
// Format lead data
return {
  fullSummary: `${data.name} from ${data.address} needs ${data.needs.join(', ')}. Budget: ${data.estimatedBudget}`,
  coldCallTalk: `Hi, is this ${data.owner} from ${data.name}? I noticed you don't have a website...`
};
```
