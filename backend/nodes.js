/**
 * AgencyFlow Node Handlers
 * Each key is a node type. Each function receives (config, ctx) and returns data object.
 */

const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { log } = require('./logger');

// Helper: resolve {{template}} variables
function resolve(str, data) {
  if (!str) return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const val = key.trim().split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : ''), data);
    return val !== undefined && val !== '' ? val : `[${key.trim()}]`;
  });
}

// Helper: call AI provider (supports free options)
async function callAI(prompt, maxTokens = 800) {
  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();

  const localFallback = () => {
    return 'Thanks for your message. We received your request and will get back to you shortly with the next steps.';
  };

  try {
    if (provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return localFallback();
      const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      });
      return res.data.content.map(c => c.text || '').join('');
    }

    if (provider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return localFallback();
      const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.4
      }, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return res.data.choices?.[0]?.message?.content || '';
    }

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) return localFallback();
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.4
    }, {
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json'
      }
    });
    return res.data.choices?.[0]?.message?.content || '';
  } catch (e) {
    log('warn', `AI fallback used: ${e.message}`);
    return localFallback();
  }
}

// ─── TRIGGER NODES (pass-through) ────────────────────────────────
const nodes = {

  trigger_webhook: async (config, ctx) => {
    ctx.log(`Webhook trigger: ${config.source}`);
    return { triggerSource: config.source, ...ctx.data.webhook };
  },

  trigger_schedule: async (config, ctx) => {
    ctx.log(`Scheduled trigger: ${config.label || config.cron}`);
    return { triggerSource: 'schedule', scheduledAt: new Date().toISOString() };
  },

  trigger_manual: async (config, ctx) => {
    ctx.log('Manual trigger fired');
    return { triggerSource: 'manual' };
  },

  // ─── AI NODES ────────────────────────────────────────────────

  action_ai_generate: async (config, ctx) => {
    const { data } = ctx;
    const settings = getSettings();
    let prompt = '';

    const templates = {
      contact_reply: `You are an assistant for ${settings.agencyName}. Write a short, warm, personalized reply to someone who just filled out the contact form.

Their message: "${data.message || data.body?.message || 'interested in your services'}"
Their name: ${data.name || data.body?.name || 'there'}
Their budget: ${data.budget || data.body?.budget || 'not specified'}

Reply in 3-4 sentences. Be friendly, confirm you received their message, mention you'll follow up within 24 hours. Sign as "${settings.founderName} from ${settings.agencyName}". Return just the email body text.`,

      whatsapp_premium: `Write a WhatsApp reply for a premium client inquiry (budget >₹50,000).
Client message: "${data.message || ''}"
Agency: ${settings.agencyName} | Contact: ${settings.founderName}
Keep under 100 words, professional, mention a free strategy call. Use 1-2 emojis.`,

      whatsapp_basic: `Write a WhatsApp reply for a basic inquiry.
Client message: "${data.message || ''}"
Agency: ${settings.agencyName}
Keep under 80 words, friendly, mention starter packages. Use emojis.`,

      cold_email: `Write a personalized cold outreach email for:
Business: ${data.name || ''} | Owner: ${data.owner || ''} | Location: ${data.address || ''}
Needs: ${(data.needs || []).join(', ')} | Pain: ${data.painPoints || ''}

Agency: ${settings.agencyName} | From: ${settings.founderName} | Email: ${settings.email}
Services: ${settings.services}

Format: Subject: [subject]\n\n[body]
Make it personalized, mention their specific gap, CTA to book a 15-min call. Under 150 words.`,

      cold_email_personalized: `Write a highly personalized cold email.
Lead data: ${JSON.stringify(data.lead || data, null, 2)}
Agency: ${settings.agencyName} | From: ${settings.founderName}
Mention their specific business name and pain point. CTA to reply or book a call. Under 120 words.`,

      call_script: `Create a 60-second cold call script for:
Business: ${data.name || data.lead?.name || ''} | Owner: ${data.owner || data.lead?.owner || ''}
Needs: ${(data.needs || data.lead?.needs || []).join(', ')}
Agency: ${settings.agencyName}

Format as:
OPENING: ...
PITCH (20 sec): ...
DISCOVERY Q: ...
HANDLE OBJECTION "not interested": ...
CLOSE: ...`,

      followup: `Write a short follow-up email (3rd touch).
Lead: ${data.name || ''} | Last contacted: ${data.lastContactedAt || '5 days ago'}
Agency: ${settings.agencyName}
Short, curious tone, ask if they had a chance to think about it. 2-3 sentences max.`,
    };

    const templateKey = config.template || 'contact_reply';
    prompt = templates[templateKey] || `Generate a professional message. Context: ${JSON.stringify(data)}`;

    ctx.log(`Calling AI (${process.env.AI_PROVIDER || 'openrouter'}) for template: ${templateKey}`);
    const reply = await callAI(prompt);
    return { ai_reply: reply, ai_template: templateKey };
  },

  action_ai_qualify: async (config, ctx) => {
    const { data } = ctx;
    const message = data.message || data.body?.Body || data.webhook?.body?.Body || '';
    ctx.log('AI qualifying lead from message...');

    const prompt = `Analyze this message from a potential client of a digital agency and extract information.

Message: "${message}"

Return ONLY a JSON object:
{
  "name": "extracted name or null",
  "budget": "extracted budget amount or null",
  "budgetNum": 0,
  "service": "what they need or null",
  "qualified": true/false (true if budget >30000 or clearly serious),
  "sentiment": "positive/neutral/negative",
  "urgency": "high/medium/low",
  "summary": "1 sentence summary for cold call prep"
}`;

    try {
      const raw = await callAI(prompt, 300);
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return { ...parsed, qualified: parsed.budgetNum > 30000 || parsed.qualified };
    } catch {
      return { qualified: false, sentiment: 'neutral', urgency: 'low', summary: message.slice(0, 100) };
    }
  },

  action_ai_prospect: async (config, ctx) => {
    const { niche = 'restaurants', location = 'Mumbai', count = 5 } = config;
    const settings = getSettings();
    ctx.log(`AI prospecting: ${count} ${niche} businesses in ${location}`);

    const prompt = `Generate ${count} realistic potential client prospects for a digital agency in ${location} targeting ${niche}.

Return ONLY a JSON array:
[{"name":"...","owner":"...","phone":"...","email":"...","address":"area, ${location}","needs":["website","logo"],"painPoints":"...","score":75,"estimatedBudget":"₹X"}]`;

    try {
      const raw = await callAI(prompt, 1000);
      const prospects = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (!Array.isArray(prospects) || !prospects.length) throw new Error('No valid prospects returned');
      // Save each as a lead
      const engine = require('./workflowEngine');
      prospects.slice(0, count).forEach(p => engine.saveLead({ ...p, status: 'New', source: 'ai_prospector' }));
      const normalized = prospects.slice(0, count).map((p, idx) => ({
        name: p.name || `${niche} Lead ${idx + 1}`,
        owner: p.owner || '',
        phone: p.phone || '',
        email: p.email || `lead${idx + 1}@example.com`,
        address: p.address || location,
        needs: p.needs || ['website'],
        painPoints: p.painPoints || '',
        score: p.score || 60,
        estimatedBudget: p.estimatedBudget || '',
        status: 'New',
        source: 'ai_prospector'
      }));
      return { prospects: normalized, count: normalized.length, niche, location };
    } catch (e) {
      ctx.log(`Prospect generation fallback: ${e.message}`);
      const fallbackProspects = generateFallbackProspects(count, niche, location);
      const engine = require('./workflowEngine');
      fallbackProspects.forEach(p => engine.saveLead({ ...p, status: 'New', source: 'ai_prospector' }));
      return { prospects: fallbackProspects, count: fallbackProspects.length, niche, location, fallback: true };
    }
  },

  // ─── CRM / LEAD NODES ────────────────────────────────────────

  action_save_lead: async (config, ctx) => {
    const { data } = ctx;
    const engine = require('./workflowEngine');
    const body = data.body || data.webhook?.body || {};

    const lead = {
      name: data.name || body.name || body.Name || '',
      email: data.email || body.email || body.Email || '',
      phone: data.phone || body.phone || body.Phone || body.From || '',
      message: data.message || body.message || body.Message || body.Body || '',
      budget: data.budget || body.budget || '',
      source: data.triggerSource || 'unknown',
      status: 'New'
    };

    const saved = engine.saveLead(lead);
    ctx.log(`Lead saved: ${saved.name} (${saved.email})`);
    return { lead: saved, leadId: saved.id };
  },

  // ─── EMAIL NODES ─────────────────────────────────────────────

  action_send_email: async (config, ctx) => {
    const { data } = ctx;
    const settings = getSettings();
    const emailConfig = getEmailConfig();

    if (!emailConfig.user) {
      ctx.log('⚠ Email not configured (set SMTP_USER and SMTP_PASS in .env). Simulating send.');
      ctx.log(`[SIMULATED] Email to: ${resolve(config.to, data) || data.email || data.lead?.email}`);
      ctx.log(`[SIMULATED] Subject: ${resolve(config.subject, data) || 'Follow-up from ' + settings.agencyName}`);
      return { emailSent: true, simulated: true };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: emailConfig.host || 'smtp.gmail.com',
        port: emailConfig.port || 587,
        secure: false,
        auth: { user: emailConfig.user, pass: emailConfig.pass }
      });

      const to = resolve(config.to, data) || data.email || data.lead?.email;
      const subject = resolve(config.subject, data) || `Message from ${settings.agencyName}`;
      const body = resolve(config.body, data) || data.ai_reply || '';

      await transporter.sendMail({
        from: `"${settings.founderName} – ${settings.agencyName}" <${emailConfig.user}>`,
        to, subject,
        text: body,
        html: `<div style="font-family:sans-serif;max-width:600px;line-height:1.6">${body.replace(/\n/g,'<br>')}</div>`
      });

      ctx.log(`Email sent to: ${to}`);
      return { emailSent: true, emailTo: to };
    } catch (e) {
      const to = resolve(config.to, data) || data.email || data.lead?.email;
      ctx.log(`⚠ Email send failed (${e.message}). Continuing in simulated mode for: ${to}`);
      return { emailSent: false, simulated: true, emailTo: to, emailError: e.message };
    }
  },

  // ─── WHATSAPP NODES ──────────────────────────────────────────

  action_whatsapp_reply: async (config, ctx) => {
    const { data } = ctx;
    const msgConfig = getMessagingConfig();
    const to = resolve(config.to, data) || data.from || data.webhook?.body?.From;
    const message = resolve(config.message, data) || data.ai_reply || '';

    if (msgConfig.provider === 'telegram' && msgConfig.telegramToken && (msgConfig.telegramChatId || to)) {
      const chatId = msgConfig.telegramChatId || to;
      await sendTelegramMessage(msgConfig.telegramToken, chatId, message);
      ctx.log(`Telegram message sent to chat: ${chatId}`);
      return { whatsappSent: false, telegramSent: true, telegramChatId: chatId };
    }

    if (!msgConfig.twilioSid) {
      ctx.log(`⚠ No messaging provider configured. Simulating message to: ${to}`);
      ctx.log(`[SIMULATED] Message: ${message.slice(0, 100)}`);
      return { simulated: true };
    }

    const twilioClient = require('twilio')(msgConfig.twilioSid, msgConfig.twilioToken);
    await twilioClient.messages.create({
      from: `whatsapp:${msgConfig.twilioFrom}`,
      to: `whatsapp:${to}`,
      body: message
    });

    ctx.log(`WhatsApp sent to: ${to}`);
    return { whatsappSent: true, whatsappTo: to };
  },

  // ─── GOOGLE SHEETS NODES ─────────────────────────────────────

  action_sheets_append: async (config, ctx) => {
    const { data } = ctx;
    const sheetsConfig = getSheetsConfig();
    const excelPath = getExcelPath(config);
    const targetSheetId = normalizeSheetId(config.sheetId) || normalizeSheetId(process.env.DEFAULT_SHEET_ID);

    if (targetSheetId && sheetsConfig.credentialsPath) {
      try {
        const credsPath = sheetsConfig.credentialsPath;
        if (!fs.existsSync(credsPath)) {
          throw new Error(`Google credentials file not found at ${credsPath}`);
        }
        const auth = new google.auth.GoogleAuth({
          keyFile: credsPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const list = Array.isArray(data.prospects) && data.prospects.length ? data.prospects : [data.lead || data];
        const rows = list.map(lead => [
          new Date().toLocaleDateString('en-IN'),
          lead.name || '', lead.owner || '', lead.phone || '',
          lead.email || '', lead.address || lead.location || '',
          Array.isArray(lead.needs) ? lead.needs.join(', ') : (lead.needs || ''),
          lead.estimatedBudget || lead.budget || '',
          lead.status || 'New', lead.score || '', lead.source || data.source || '',
          lead.painPoints || lead.notes || ''
        ]);

        const preferredRange = config.range || 'Leads!A:L';
        const fallbackRange = 'Sheet1!A:L';
        let appended = false;
        let usedRange = preferredRange;

        try {
          await sheets.spreadsheets.values.append({
            spreadsheetId: targetSheetId,
            range: preferredRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: rows }
          });
          appended = true;
        } catch (appendErr) {
          // If named tab doesn't exist, retry with Sheet1.
          await sheets.spreadsheets.values.append({
            spreadsheetId: targetSheetId,
            range: fallbackRange,
            valueInputOption: 'USER_ENTERED',
            resource: { values: rows }
          });
          appended = true;
          usedRange = fallbackRange;
          ctx.log(`Primary range append failed (${appendErr.message}). Retried with ${fallbackRange}`);
        }

        if (appended) {
          ctx.log(`Rows appended to Google Sheet: ${rows.length} (${targetSheetId}, ${usedRange})`);
          return { sheetsAppended: true, google: true, appendedCount: rows.length };
        }
      } catch (e) {
        ctx.log(`Google Sheets append fallback: ${e.message}`);
      }
    }

    if (excelPath) {
      const list = Array.isArray(data.prospects) && data.prospects.length ? data.prospects : [data.lead || data];
      let appendedCount = 0;
      for (const lead of list) {
        const rowObj = {
          Date: new Date().toLocaleDateString('en-IN'),
          'Business Name': lead.name || '',
          Owner: lead.owner || '',
          Phone: lead.phone || '',
          Email: lead.email || '',
          Address: lead.address || lead.location || '',
          Needs: Array.isArray(lead.needs) ? lead.needs.join(', ') : (lead.needs || ''),
          Budget: lead.estimatedBudget || lead.budget || '',
          Status: lead.status || 'New',
          Score: lead.score || '',
          Source: lead.source || data.source || '',
          Notes: lead.painPoints || lead.notes || ''
        };
        if (appendRowToExcel(excelPath, config.sheetName || 'Leads', rowObj)) appendedCount += 1;
      }
      if (appendedCount > 0) {
        ctx.log(`Rows appended to Excel: ${appendedCount} (${excelPath})`);
        return { sheetsAppended: true, excel: true, appendedCount };
      }
      ctx.log(`Excel append failed for: ${excelPath}`);
      return { sheetsAppended: false, excel: true, skipped: true };
    }

    if (targetSheetId && !sheetsConfig.credentialsPath) {
      ctx.log('⚠ DEFAULT_SHEET_ID is set but GOOGLE_CREDENTIALS_PATH file is missing. Using Excel fallback.');
    }

    if (!excelPath && !sheetsConfig.credentialsPath) {
      ctx.log('⚠ No Excel or Google Sheets configured. Skipping append.');
      return { sheetsAppended: false, skipped: true };
    }

    return { sheetsAppended: false, skipped: true };
  },

  action_sheets_read: async (config, ctx) => {
    const sheetsConfig = getSheetsConfig();
    const excelPath = getExcelPath(config);

    if (excelPath) {
      const rows = readExcelAsObjects(excelPath, config.sheetName || 'Leads');
      ctx.log(`Read ${rows.length} rows from Excel`);
      return { leads: rows, leadsCount: rows.length, excel: true };
    }

    if (!sheetsConfig.credentialsPath) {
      ctx.log('⚠ No Excel or Google Sheets configured. Returning empty rows.');
      return { leads: [], leadsCount: 0 };
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: sheetsConfig.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: config.range || 'Sheet1!A:L'
    });

    const [headers, ...rows] = res.data.values || [[]];
    const leads = rows.map(r => {
      const obj = {};
      (headers || []).forEach((h, i) => { obj[h.toLowerCase().replace(/\s+/g,'_')] = r[i] || ''; });
      return obj;
    });

    ctx.log(`Read ${leads.length} rows from sheet`);
    return { leads, leadsCount: leads.length };
  },

  action_sheets_update: async (config, ctx) => {
    const excelPath = getExcelPath(config);
    if (excelPath) {
      const updated = updateExcelStatus(excelPath, config.sheetName || 'Leads', ctx.data, config.value || 'Contacted');
      ctx.log(updated ? 'Excel status updated' : 'Excel row not found for update');
      return { sheetsUpdated: updated, excel: true };
    }

    ctx.log(`[SIMULATED] Sheet status update: ${config.value}`);
    return { sheetsUpdated: true, simulated: true };
  },

  // ─── CONDITION NODE ──────────────────────────────────────────

  action_condition: async (config, ctx) => {
    const { data } = ctx;
    try {
      const fn = new Function('data', `return !!(${config.condition})`);
      const result = fn(data);
      ctx.log(`Condition "${config.condition}" = ${result}`);
      return { conditionResult: result };
    } catch (e) {
      ctx.log(`Condition eval error: ${e.message}`);
      return { conditionResult: false };
    }
  },

  // ─── JAVASCRIPT NODE ─────────────────────────────────────────

  action_javascript: async (config, ctx) => {
    ctx.log('Executing custom JavaScript...');
    try {
      const fn = new Function('data', 'require', config.code || 'return {};');
      const result = fn(ctx.data, require);
      ctx.log('JavaScript executed successfully');
      return result || {};
    } catch (e) {
      ctx.log(`JS execution error: ${e.message}`);
      throw e;
    }
  },

  // ─── HTTP / API NODE ─────────────────────────────────────────

  action_http_request: async (config, ctx) => {
    const { data } = ctx;
    const url = resolve(config.url, data);
    const method = (config.method || 'GET').toUpperCase();
    ctx.log(`HTTP ${method} → ${url}`);

    const res = await axios({
      method,
      url,
      headers: config.headers || {},
      data: config.body ? JSON.parse(resolve(JSON.stringify(config.body), data)) : undefined,
      params: config.params || {}
    });

    ctx.log(`HTTP response: ${res.status}`);
    return { httpResponse: res.data, httpStatus: res.status };
  },

  // ─── NOTIFY NODE ─────────────────────────────────────────────

  action_notify: async (config, ctx) => {
    const { data } = ctx;
    const message = resolve(config.message, data);
    ctx.log(`[NOTIFICATION] ${message}`);

    // Try Slack if configured
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (slackWebhook) {
      try {
        await axios.post(slackWebhook, { text: message });
        ctx.log('Slack notification sent');
      } catch { ctx.log('Slack notify failed'); }
    }

    // Try WhatsApp if configured
    const msgConfig = getMessagingConfig();
    if (msgConfig.provider === 'telegram' && msgConfig.telegramToken && msgConfig.telegramChatId) {
      try {
        await sendTelegramMessage(msgConfig.telegramToken, msgConfig.telegramChatId, message);
        ctx.log('Telegram notification sent');
      } catch { ctx.log('Telegram notify failed'); }
    } else if (msgConfig.twilioSid && msgConfig.notifyWhatsapp) {
      try {
        const twilioClient = require('twilio')(msgConfig.twilioSid, msgConfig.twilioToken);
        await twilioClient.messages.create({
          from: `whatsapp:${msgConfig.twilioFrom}`,
          to: `whatsapp:${msgConfig.notifyWhatsapp}`,
          body: message
        });
        ctx.log('WhatsApp notification sent');
      } catch { ctx.log('WhatsApp notify failed'); }
    }

    global.broadcast('notification', { message });
    return { notified: true, message };
  },

  // ─── DELAY NODE ──────────────────────────────────────────────

  action_delay: async (config, ctx) => {
    const ms = (config.seconds || 1) * 1000;
    ctx.log(`Waiting ${config.seconds || 1}s...`);
    await new Promise(r => setTimeout(r, ms));
    return {};
  },

};

// Config helpers
function getSettings() {
  try {
    const fs = require('fs');
    const path = require('path');
    const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const dataDir = process.env.DATA_DIR || (isServerless ? '/tmp/agencyflow' : path.join(__dirname, '../data'));
    const f = path.join(dataDir, 'settings.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {
      agencyName: process.env.AGENCY_NAME || 'My Agency',
      founderName: process.env.FOUNDER_NAME || 'Your Name',
      email: process.env.AGENCY_EMAIL || 'hello@agency.com',
      services: 'Web Design, Logo Design, Social Media, Content Writing, SEO, Marketing'
    };
  }
}

function getEmailConfig() {
  return {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587')
  };
}

function getMessagingConfig() {
  return {
    provider: (process.env.MESSAGING_PROVIDER || 'telegram').toLowerCase(),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM || '+14155238886',
    notifyWhatsapp: process.env.NOTIFY_WHATSAPP || ''
  };
}

function getSheetsConfig() {
  return {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || ''
  };
}

function normalizeSheetId(value) {
  if (!value) return '';
  const v = String(value).trim();
  if (!v) return '';
  if (v === 'YOUR_SHEET_ID' || v === 'your_sheet_id_here') return '';
  return v;
}

function getExcelPath(config = {}) {
  return config.excelFile
    || config.excelFilePath
    || process.env.EXCEL_FILE_PATH
    || process.env.CLIENT_OUTREACH_FILE_PATH
    || process.env.INCOME_FILE_PATH
    || process.env.EXPENSE_FILE_PATH
    || '';
}

async function sendTelegramMessage(token, chatId, text) {
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text
  });
}

function ensureWorkbook(filePath) {
  if (fs.existsSync(filePath)) return XLSX.readFile(filePath);
  const wb = XLSX.utils.book_new();
  return wb;
}

function appendRowToExcel(filePath, sheetName, rowObj) {
  try {
    const wb = ensureWorkbook(filePath);
    const ws = wb.Sheets[sheetName];
    const existing = ws ? XLSX.utils.sheet_to_json(ws, { defval: '' }) : [];
    existing.push(rowObj);
    const nextWs = XLSX.utils.json_to_sheet(existing);
    wb.Sheets[sheetName] = nextWs;
    if (!wb.SheetNames.includes(sheetName)) wb.SheetNames.push(sheetName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    XLSX.writeFile(wb, filePath);
    return true;
  } catch {
    return false;
  }
}

function readExcelAsObjects(filePath, sheetName) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const wb = XLSX.readFile(filePath);
    const target = wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
    if (!target) return [];
    return XLSX.utils.sheet_to_json(wb.Sheets[target], { defval: '' });
  } catch {
    return [];
  }
}

function updateExcelStatus(filePath, sheetName, data, nextStatus) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const wb = XLSX.readFile(filePath);
    const target = wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
    if (!target) return false;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[target], { defval: '' });
    const email = (data.lead?.email || data.email || '').toLowerCase();
    const phone = (data.lead?.phone || data.phone || '').toString();
    const idx = rows.findIndex(r =>
      ((r.Email || '').toString().toLowerCase() === email && email) ||
      ((r.Phone || '').toString() === phone && phone)
    );
    if (idx < 0) return false;
    rows[idx].Status = nextStatus;
    wb.Sheets[target] = XLSX.utils.json_to_sheet(rows);
    XLSX.writeFile(wb, filePath);
    return true;
  } catch {
    return false;
  }
}

function generateFallbackProspects(count, niche, location) {
  const safeCount = Math.max(1, Math.min(Number(count) || 10, 50));
  const out = [];
  for (let i = 1; i <= safeCount; i += 1) {
    out.push({
      name: `${location} ${niche} Lead ${i}`,
      owner: `Owner ${i}`,
      phone: `900000${String(i).padStart(4, '0')}`,
      email: `lead${i}.${String(location).toLowerCase().replace(/\s+/g, '')}@example.com`,
      address: location,
      needs: ['website', 'social media'],
      painPoints: `Needs better online visibility in ${location}`,
      score: 55 + (i % 40),
      estimatedBudget: `INR ${30000 + i * 1000}`,
      status: 'New',
      source: 'ai_prospector'
    });
  }
  return out;
}

module.exports = nodes;
