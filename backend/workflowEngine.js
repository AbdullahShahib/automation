/**
 * AgencyFlow Workflow Engine
 * Executes node-based automation workflows
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { log } = require('./logger');

const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const DATA_DIR = process.env.DATA_DIR || (isServerless ? '/tmp/agencyflow' : path.join(__dirname, '../data'));
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const EXECUTIONS_FILE = path.join(DATA_DIR, 'executions.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// Load node handlers
const nodeHandlers = require('./nodes');

class WorkflowEngine {
  constructor() {
    this.scheduledJobs = {};
    this.ensureDataFiles();
  }

  ensureDataFiles() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(WORKFLOWS_FILE)) fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(this.getDefaultWorkflows(), null, 2));
      if (!fs.existsSync(EXECUTIONS_FILE)) fs.writeFileSync(EXECUTIONS_FILE, '[]');
      if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');
    } catch (e) {
      log('warn', `Data file init fallback: ${e.message}`);
    }
  }

  // ─── WORKFLOW CRUD ────────────────────────────────────────────
  getWorkflows() {
    try { return JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')); }
    catch { return []; }
  }

  saveWorkflows(workflows) {
    fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2));
  }

  getWorkflow(id) {
    return this.getWorkflows().find(w => w.id === id);
  }

  saveWorkflow(workflow) {
    const workflows = this.getWorkflows();
    const idx = workflows.findIndex(w => w.id === workflow.id);
    if (idx >= 0) workflows[idx] = workflow;
    else workflows.push(workflow);
    this.saveWorkflows(workflows);
    return workflow;
  }

  deleteWorkflow(id) {
    const workflows = this.getWorkflows().filter(w => w.id !== id);
    this.saveWorkflows(workflows);
    this.stopScheduledJob(id);
  }

  // ─── EXECUTION ────────────────────────────────────────────────
  async runWorkflow(workflowId, inputData = {}, triggerSource = 'manual') {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
    if (!workflow.active) {
      log('info', `Workflow ${workflow.name} is inactive, skipping`);
      return {
        id: `exec_${Date.now()}_skipped`,
        workflowId,
        workflowName: workflow.name,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'skipped',
        trigger: triggerSource,
        reason: 'Workflow is inactive'
      };
    }

    const execId = `exec_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const execution = {
      id: execId,
      workflowId,
      workflowName: workflow.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      trigger: triggerSource,
      steps: [],
      inputData
    };

    log('info', `Starting execution ${execId} for workflow: ${workflow.name}`);
    global.broadcast('execution_start', { execId, workflowId, workflowName: workflow.name });

    try {
      // Build execution context
      const ctx = {
        data: { ...inputData },
        workflow,
        execId,
        log: (msg) => {
          const step = { ts: new Date().toISOString(), msg };
          execution.steps.push(step);
          global.broadcast('execution_step', { execId, step });
        }
      };

      // Find trigger node and start traversal
      const triggerNode = workflow.nodes.find(n => n.type.startsWith('trigger_'));
      if (!triggerNode) throw new Error('No trigger node found');

      await this.executeNode(triggerNode, ctx, workflow);

      execution.status = 'success';
      execution.finishedAt = new Date().toISOString();
      log('info', `Execution ${execId} completed successfully`);

    } catch (e) {
      execution.status = 'error';
      execution.error = e.message;
      execution.finishedAt = new Date().toISOString();
      log('error', `Execution ${execId} failed: ${e.message}`);
    }

    // Save execution log
    const executions = this.getExecutions();
    executions.unshift(execution);
    if (executions.length > 200) executions.splice(200);
    fs.writeFileSync(EXECUTIONS_FILE, JSON.stringify(executions, null, 2));

    global.broadcast('execution_end', { execId, status: execution.status, workflowName: workflow.name });
    return execution;
  }

  async executeNode(node, ctx, workflow) {
    ctx.log(`▶ Node: ${node.label || node.type}`);
    global.broadcast('node_active', { execId: ctx.execId, nodeId: node.id });

    const handler = nodeHandlers[node.type];
    if (!handler) {
      ctx.log(`⚠ No handler for node type: ${node.type}`);
      return;
    }

    try {
      const result = await handler(node.config || {}, ctx);
      if (result) ctx.data = { ...ctx.data, ...result };
      ctx.log(`✓ Node ${node.label || node.type} completed`);
      global.broadcast('node_done', { execId: ctx.execId, nodeId: node.id });
    } catch (e) {
      ctx.log(`✗ Node ${node.label || node.type} failed: ${e.message}`);
      global.broadcast('node_error', { execId: ctx.execId, nodeId: node.id, error: e.message });
      throw e;
    }

    // Find connected nodes and execute them
    const connections = workflow.connections.filter(c => c.from === node.id);
    for (const conn of connections) {
      // Check condition if present
      if (conn.condition) {
        try {
          const condFn = new Function('data', `return (${conn.condition})`);
          if (!condFn(ctx.data)) { ctx.log(`↷ Condition false, skipping branch`); continue; }
        } catch { /* skip bad condition */ }
      }
      const nextNode = workflow.nodes.find(n => n.id === conn.to);
      if (nextNode) await this.executeNode(nextNode, ctx, workflow);
    }
  }

  // ─── WEBHOOK HANDLER ──────────────────────────────────────────
  async handleWebhook(source, body, headers) {
    const workflows = this.getWorkflows();
    const matching = workflows.filter(w =>
      w.active && w.nodes.some(n => n.type === 'trigger_webhook' && n.config?.source === source)
    );

    if (!matching.length) {
      log('warn', `No active workflow for webhook source: ${source}`);
      return;
    }

    for (const wf of matching) {
      await this.runWorkflow(wf.id, { webhook: { source, body, headers, ts: Date.now() } }, `webhook:${source}`);
    }
  }

  // ─── SCHEDULER ────────────────────────────────────────────────
  startScheduledJobs() {
    const workflows = this.getWorkflows();
    workflows.forEach(wf => {
      const schedNode = wf.nodes?.find(n => n.type === 'trigger_schedule');
      if (schedNode && wf.active && schedNode.config?.cron) {
        this.scheduleWorkflow(wf.id, schedNode.config.cron);
      }
    });
    log('info', `Started ${Object.keys(this.scheduledJobs).length} scheduled workflows`);
  }

  scheduleWorkflow(workflowId, cronExpr) {
    this.stopScheduledJob(workflowId);
    try {
      this.scheduledJobs[workflowId] = cron.schedule(cronExpr, () => {
        this.runWorkflow(workflowId, {}, 'schedule');
      });
      log('info', `Scheduled workflow ${workflowId} with cron: ${cronExpr}`);
    } catch (e) {
      log('error', `Invalid cron for workflow ${workflowId}: ${e.message}`);
    }
  }

  stopScheduledJob(workflowId) {
    const job = this.scheduledJobs[workflowId];
    if (!job) return;
    try {
      if (typeof job.destroy === 'function') job.destroy();
      else if (typeof job.stop === 'function') job.stop();
    } catch (e) {
      log('warn', `Failed to stop scheduled job ${workflowId}: ${e.message}`);
    }
    delete this.scheduledJobs[workflowId];
  }

  // ─── EXECUTIONS ───────────────────────────────────────────────
  getExecutions(workflowId) {
    try {
      const all = JSON.parse(fs.readFileSync(EXECUTIONS_FILE, 'utf8'));
      return workflowId ? all.filter(e => e.workflowId === workflowId) : all;
    } catch { return []; }
  }

  // ─── LEADS ────────────────────────────────────────────────────
  getLeads() {
    try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
    catch { return []; }
  }

  saveLead(lead) {
    const leads = this.getLeads();
    const existing = leads.findIndex(l => l.email === lead.email || l.phone === lead.phone);
    const entry = { ...lead, id: lead.id || `lead_${Date.now()}`, updatedAt: new Date().toISOString() };
    if (existing >= 0) leads[existing] = { ...leads[existing], ...entry };
    else { entry.createdAt = new Date().toISOString(); leads.unshift(entry); }
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
    global.broadcast('lead_updated', entry);
    return entry;
  }

  // ─── DEFAULT WORKFLOWS ────────────────────────────────────────
  getDefaultWorkflows() {
    return [
      {
        id: 'wf_contact_form',
        name: '🌐 Contact Form Auto-Reply',
        description: 'When someone fills your portfolio contact form → save lead → send instant reply email → notify you on WhatsApp',
        active: true,
        color: '#7c5cfc',
        category: 'leads',
        nodes: [
          { id: 'n1', type: 'trigger_webhook', label: 'Contact Form Submitted', config: { source: 'contact_form' }, x: 60, y: 200 },
          { id: 'n2', type: 'action_save_lead', label: 'Save Lead to CRM', config: { fields: ['name','email','phone','message','budget'] }, x: 320, y: 200 },
          { id: 'n3', type: 'action_ai_generate', label: 'Generate Reply with AI', config: { template: 'contact_reply', tone: 'friendly' }, x: 580, y: 200 },
          { id: 'n4', type: 'action_send_email', label: 'Send Auto-Reply Email', config: { to: '{{data.email}}', subject: 'Thanks for reaching out!', body: '{{data.ai_reply}}' }, x: 840, y: 200 },
          { id: 'n5', type: 'action_sheets_append', label: 'Add to Google Sheet', config: { sheetId: 'YOUR_SHEET_ID', range: 'Leads!A:Z' }, x: 840, y: 340 },
          { id: 'n6', type: 'action_notify', label: 'Notify Me (WhatsApp/Slack)', config: { message: '🔔 New lead: {{data.name}} ({{data.email}}) Budget: {{data.budget}}' }, x: 580, y: 340 }
        ],
        connections: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
          { from: 'n3', to: 'n4' },
          { from: 'n2', to: 'n5' },
          { from: 'n2', to: 'n6' }
        ]
      },
      {
        id: 'wf_whatsapp_reply',
        name: '💬 WhatsApp Auto-Responder',
        description: 'Incoming WhatsApp message → AI qualifies lead → sends smart reply → logs to CRM',
        active: true,
        color: '#00e5b0',
        category: 'messaging',
        nodes: [
          { id: 'n1', type: 'trigger_webhook', label: 'WhatsApp Message Received', config: { source: 'whatsapp' }, x: 60, y: 200 },
          { id: 'n2', type: 'action_ai_qualify', label: 'AI Lead Qualifier', config: { budgetKey: 'data.message' }, x: 320, y: 200 },
          { id: 'n3', type: 'action_condition', label: 'Budget Check', config: { condition: 'data.qualified === true' }, x: 580, y: 200 },
          { id: 'n4', type: 'action_ai_generate', label: 'Generate Premium Reply', config: { template: 'whatsapp_premium', tone: 'professional' }, x: 840, y: 120 },
          { id: 'n5', type: 'action_ai_generate', label: 'Generate Basic Reply', config: { template: 'whatsapp_basic', tone: 'friendly' }, x: 840, y: 280 },
          { id: 'n6', type: 'action_whatsapp_reply', label: 'Send WhatsApp Reply', config: { to: '{{data.from}}', message: '{{data.ai_reply}}' }, x: 1100, y: 200 },
          { id: 'n7', type: 'action_save_lead', label: 'Save to CRM', config: {}, x: 1100, y: 340 }
        ],
        connections: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
          { from: 'n3', to: 'n4', condition: 'data.qualified === true' },
          { from: 'n3', to: 'n5', condition: 'data.qualified !== true' },
          { from: 'n4', to: 'n6' },
          { from: 'n5', to: 'n6' },
          { from: 'n6', to: 'n7' }
        ]
      },
      {
        id: 'wf_daily_prospecting',
        name: '🎯 Daily Lead Prospector',
        description: 'Every morning: AI finds 10 new leads in your target niche → generates cold emails → queues them for sending',
        active: false,
        color: '#f5c842',
        category: 'prospecting',
        nodes: [
          { id: 'n1', type: 'trigger_schedule', label: 'Every Morning 9AM', config: { cron: '0 9 * * *', label: 'Daily 9:00 AM' }, x: 60, y: 200 },
          { id: 'n2', type: 'action_ai_prospect', label: 'AI Find Leads', config: { niche: 'restaurants', location: 'Mumbai', count: 10 }, x: 320, y: 200 },
          { id: 'n3', type: 'action_ai_generate', label: 'Generate Cold Emails', config: { template: 'cold_email', bulk: true }, x: 580, y: 200 },
          { id: 'n4', type: 'action_sheets_append', label: 'Log to Sheet', config: { sheetId: 'YOUR_SHEET_ID', range: 'Prospects!A:Z' }, x: 840, y: 200 },
          { id: 'n5', type: 'action_notify', label: 'Send Me Daily Summary', config: { message: '📊 Found {{data.count}} new leads today in {{data.niche}}' }, x: 840, y: 340 }
        ],
        connections: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
          { from: 'n3', to: 'n4' },
          { from: 'n4', to: 'n5' }
        ]
      },
      {
        id: 'wf_cold_outreach',
        name: '📧 Cold Email Outreach Campaign',
        description: 'Manually triggered: for each lead in sheet → generate personalized email → send → update status',
        active: true,
        color: '#ff6b6b',
        category: 'outreach',
        nodes: [
          { id: 'n1', type: 'trigger_manual', label: 'Manual / Webhook Trigger', config: { source: 'outreach' }, x: 60, y: 200 },
          { id: 'n2', type: 'action_sheets_read', label: 'Read Leads from Sheet', config: { sheetId: 'YOUR_SHEET_ID', range: 'Leads!A:Z', filter: 'status=New' }, x: 320, y: 200 },
          { id: 'n3', type: 'action_ai_generate', label: 'AI: Personalized Email', config: { template: 'cold_email_personalized' }, x: 580, y: 200 },
          { id: 'n4', type: 'action_ai_generate', label: 'AI: Cold Call Summary', config: { template: 'call_script' }, x: 580, y: 340 },
          { id: 'n5', type: 'action_send_email', label: 'Send Cold Email', config: { delay: 2000 }, x: 840, y: 200 },
          { id: 'n6', type: 'action_sheets_update', label: 'Update Status: Contacted', config: { statusCol: 'I', value: 'Contacted' }, x: 840, y: 340 }
        ],
        connections: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
          { from: 'n2', to: 'n4' },
          { from: 'n3', to: 'n5' },
          { from: 'n5', to: 'n6' }
        ]
      },
      {
        id: 'wf_follow_up',
        name: '🔄 Follow-Up Sequence',
        description: 'Every Monday: check leads not replied in 5 days → send follow-up → update sheet',
        active: false,
        color: '#a78bfa',
        category: 'outreach',
        nodes: [
          { id: 'n1', type: 'trigger_schedule', label: 'Every Monday 10AM', config: { cron: '0 10 * * 1', label: 'Weekly Monday' }, x: 60, y: 200 },
          { id: 'n2', type: 'action_sheets_read', label: 'Get Stale Leads', config: { sheetId: 'YOUR_SHEET_ID', filter: 'status=Contacted&days>5' }, x: 320, y: 200 },
          { id: 'n3', type: 'action_ai_generate', label: 'AI Follow-Up Email', config: { template: 'followup' }, x: 580, y: 200 },
          { id: 'n4', type: 'action_send_email', label: 'Send Follow-Up', config: {}, x: 840, y: 200 },
          { id: 'n5', type: 'action_sheets_update', label: 'Mark Followed Up', config: { statusCol: 'I', value: 'Followed Up' }, x: 840, y: 340 }
        ],
        connections: [
          { from: 'n1', to: 'n2' },
          { from: 'n2', to: 'n3' },
          { from: 'n3', to: 'n4' },
          { from: 'n4', to: 'n5' }
        ]
      }
    ];
  }
}

module.exports = new WorkflowEngine();
