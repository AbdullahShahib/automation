/**
 * AgencyFlow Automation Server
 * Main Express + WebSocket server
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');

const workflowEngine = require('./workflowEngine');
const routes = require('./routes');
const { log } = require('./logger');

const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const app = express();
const server = isServerless ? null : http.createServer(app);
const wss = isServerless ? null : new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// WebSocket broadcast helper
global.broadcast = (type, payload) => {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
};

// WebSocket connection
if (wss) {
  wss.on('connection', (ws) => {
    log('info', 'WebSocket client connected');
    ws.send(JSON.stringify({ type: 'connected', payload: { message: 'AgencyFlow live!' } }));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'run_workflow') {
          await workflowEngine.runWorkflow(msg.workflowId, msg.inputData || {});
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e) {
        log('error', 'WS message error: ' + e.message);
      }
    });
  });
}

// API Routes
app.use('/api', routes);

// Webhook endpoint - receives from contact forms, WhatsApp, etc.
app.post('/webhook/:source', async (req, res) => {
  const { source } = req.params;
  log('info', `Webhook received from: ${source}`);

  try {
    await workflowEngine.handleWebhook(source, req.body, req.headers);
    res.json({ success: true, message: 'Webhook processed' });
  } catch (e) {
    log('error', `Webhook error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

if (!isServerless) {
  // Start scheduled workflows in long-running server mode only.
  workflowEngine.startScheduledJobs();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    log('info', `AgencyFlow running on http://localhost:${PORT}`);
    log('info', 'Webhook URL: http://localhost:' + PORT + '/webhook/:source');
  });
}

module.exports = { app, server };
