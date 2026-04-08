/**
 * AgencyFlow API Routes
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const engine = require('./workflowEngine');
const { log } = require('./logger');

const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = process.env.DATA_DIR || (isServerless ? '/tmp/agencyflow' : path.join(__dirname, '../data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// ─── WORKFLOWS ────────────────────────────────────────────────
router.get('/workflows', (req, res) => {
  res.json(engine.getWorkflows());
});

router.get('/workflows/:id', (req, res) => {
  const wf = engine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf);
});

router.post('/workflows', (req, res) => {
  const wf = {
    id: 'wf_' + Date.now(),
    name: req.body.name || 'New Workflow',
    description: req.body.description || '',
    active: false,
    color: req.body.color || '#7c5cfc',
    category: req.body.category || 'custom',
    nodes: req.body.nodes || [],
    connections: req.body.connections || [],
    createdAt: new Date().toISOString()
  };
  engine.saveWorkflow(wf);
  res.json(wf);
});

router.put('/workflows/:id', (req, res) => {
  const existing = engine.getWorkflow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = { ...existing, ...req.body, id: req.params.id };
  engine.saveWorkflow(updated);

  // Reschedule if needed
  const schedNode = updated.nodes?.find(n => n.type === 'trigger_schedule');
  if (schedNode && updated.active && schedNode.config?.cron) {
    engine.scheduleWorkflow(updated.id, schedNode.config.cron);
  }
  res.json(updated);
});

router.delete('/workflows/:id', (req, res) => {
  engine.deleteWorkflow(req.params.id);
  res.json({ success: true });
});

router.post('/workflows/:id/run', async (req, res) => {
  try {
    const exec = await engine.runWorkflow(req.params.id, req.body || {}, 'api');
    res.json(exec);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/workflows/:id/toggle', (req, res) => {
  const wf = engine.getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  wf.active = !wf.active;
  engine.saveWorkflow(wf);
  res.json({ id: wf.id, active: wf.active });
});

// ─── EXECUTIONS ───────────────────────────────────────────────
router.get('/executions', (req, res) => {
  const { workflowId, limit = 50 } = req.query;
  const execs = engine.getExecutions(workflowId).slice(0, parseInt(limit));
  res.json(execs);
});

// ─── LEADS / CRM ──────────────────────────────────────────────
router.get('/leads', (req, res) => {
  res.json(engine.getLeads());
});

router.post('/leads', (req, res) => {
  const lead = engine.saveLead(req.body);
  res.json(lead);
});

router.patch('/leads/:id', (req, res) => {
  const leads = engine.getLeads();
  const idx = leads.findIndex(l => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const fs2 = require('fs');
  leads[idx] = { ...leads[idx], ...req.body, updatedAt: new Date().toISOString() };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs2.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  global.broadcast('lead_updated', leads[idx]);
  res.json(leads[idx]);
});

router.delete('/leads/:id', (req, res) => {
  const leads = engine.getLeads();
  const nextLeads = leads.filter(l => l.id !== req.params.id);
  if (nextLeads.length === leads.length) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEADS_FILE, JSON.stringify(nextLeads, null, 2));
  global.broadcast('lead_updated', { deletedId: req.params.id });
  res.json({ success: true });
});

// ─── SETTINGS ─────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch { res.json({ agencyName: '', founderName: '', email: '', services: '' }); }
});

router.post('/settings', (req, res) => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// ─── NODE TYPES ───────────────────────────────────────────────
router.get('/node-types', (req, res) => {
  res.json([
    // Triggers
    { type: 'trigger_webhook', category: 'trigger', label: 'Webhook / Form', icon: '🌐', color: '#7c5cfc', description: 'Trigger when a webhook is received (contact form, WhatsApp, etc.)' },
    { type: 'trigger_schedule', category: 'trigger', label: 'Schedule', icon: '⏰', color: '#7c5cfc', description: 'Run workflow on a cron schedule (e.g. daily, weekly)' },
    { type: 'trigger_manual', category: 'trigger', label: 'Manual', icon: '▶', color: '#7c5cfc', description: 'Trigger manually or via API call' },
    // AI
    { type: 'action_ai_generate', category: 'ai', label: 'AI Generate', icon: '🧠', color: '#a78bfa', description: 'Use Claude AI to generate emails, messages, scripts' },
    { type: 'action_ai_qualify', category: 'ai', label: 'AI Qualify Lead', icon: '🎯', color: '#a78bfa', description: 'AI extracts budget, intent, urgency from a message' },
    { type: 'action_ai_prospect', category: 'ai', label: 'AI Prospect', icon: '🔍', color: '#a78bfa', description: 'AI generates a list of potential clients in a niche' },
    // Communication
    { type: 'action_send_email', category: 'comms', label: 'Send Email', icon: '📧', color: '#00e5b0', description: 'Send email via SMTP/Gmail' },
    { type: 'action_whatsapp_reply', category: 'comms', label: 'Message Reply', icon: '💬', color: '#00e5b0', description: 'Send via Telegram (free) or Twilio WhatsApp' },
    { type: 'action_notify', category: 'comms', label: 'Notify Me', icon: '🔔', color: '#00e5b0', description: 'Send notification to Slack or your WhatsApp' },
    // Data
    { type: 'action_save_lead', category: 'data', label: 'Save Lead', icon: '💾', color: '#f5c842', description: 'Save/update lead in the built-in CRM' },
    { type: 'action_sheets_append', category: 'data', label: 'Sheet: Add Row', icon: '📊', color: '#f5c842', description: 'Append a row to Excel or Google Sheets' },
    { type: 'action_sheets_read', category: 'data', label: 'Sheet: Read', icon: '📖', color: '#f5c842', description: 'Read rows from Excel or Google Sheets' },
    { type: 'action_sheets_update', category: 'data', label: 'Sheet: Update', icon: '✏️', color: '#f5c842', description: 'Update status in Excel or Google Sheets' },
    // Logic
    { type: 'action_condition', category: 'logic', label: 'Condition / If', icon: '🔀', color: '#ff6b6b', description: 'Branch workflow based on a condition (e.g. budget > ₹50000)' },
    { type: 'action_javascript', category: 'logic', label: 'Custom JavaScript', icon: '{ }', color: '#ff6b6b', description: 'Run custom JavaScript code' },
    { type: 'action_http_request', category: 'logic', label: 'HTTP Request', icon: '🌐', color: '#ff6b6b', description: 'Call any external API' },
    { type: 'action_delay', category: 'logic', label: 'Delay', icon: '⏱', color: '#ff6b6b', description: 'Wait N seconds before next step' },
  ]);
});

// ─── STATS ────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const workflows = engine.getWorkflows();
  const executions = engine.getExecutions();
  const leads = engine.getLeads();
  res.json({
    workflows: workflows.length,
    activeWorkflows: workflows.filter(w => w.active).length,
    executions: executions.length,
    successRate: executions.length ? Math.round(executions.filter(e => e.status === 'success').length / executions.length * 100) : 0,
    leads: leads.length,
    newLeads: leads.filter(l => l.status === 'New').length,
    contacted: leads.filter(l => l.status === 'Contacted').length,
    closed: leads.filter(l => l.status === 'Closed').length,
  });
});

module.exports = router;
