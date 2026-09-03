/**
 * AWS Lambda handler for the Client Timesheet App API
 * 
 * This wraps the Express app using serverless-http for Lambda compatibility.
 * Uses DynamoDB in cloud mode, SQLite in local mode.
 */

const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const Joi = require('joi');

const db = require('./database');

const app = express();

// Security middleware (relaxed for Lambda)
app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'demo-secret-change-in-production';

// Auth middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Validation schemas
const schemas = {
  email: Joi.object({ email: Joi.string().email().required() }),
  client: Joi.object({
    name: Joi.string().min(1).max(100).required(),
    description: Joi.string().max(500).allow('', null),
    department: Joi.string().max(100).allow('', null),
    email: Joi.string().email().allow('', null)
  }),
  workEntry: Joi.object({
    client_id: Joi.string().required(),
    hours: Joi.number().positive().max(24).required(),
    description: Joi.string().max(500).allow('', null),
    date: Joi.string().isoDate().required()
  })
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', mode: process.env.DB_MODE || 'sqlite', timestamp: new Date().toISOString() });
});

// =============================================================================
// Auth Routes
// =============================================================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { error, value } = schemas.email.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { email } = value;
    
    let user = await db.getUser(email);
    if (!user) {
      user = await db.createUser(email);
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await db.getUser(req.user.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// Client Routes
// =============================================================================

app.get('/api/clients', authenticate, async (req, res) => {
  try {
    const clients = await db.getClientsByUser(req.user.email);
    res.json(clients);
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/clients/:id', authenticate, async (req, res) => {
  try {
    const client = await db.getClientById(req.params.id);
    if (!client || client.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(client);
  } catch (error) {
    console.error('Get client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/clients', authenticate, async (req, res) => {
  try {
    const { error, value } = schemas.client.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const client = await db.createClient({ ...value, user_email: req.user.email });
    res.status(201).json(client);
  } catch (error) {
    console.error('Create client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/clients/:id', authenticate, async (req, res) => {
  try {
    const existing = await db.getClientById(req.params.id);
    if (!existing || existing.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { error, value } = schemas.client.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const client = await db.updateClient(req.params.id, value);
    res.json(client);
  } catch (error) {
    console.error('Update client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/clients/:id', authenticate, async (req, res) => {
  try {
    const existing = await db.getClientById(req.params.id);
    if (!existing || existing.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await db.deleteClient(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Delete client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// Work Entry Routes
// =============================================================================

app.get('/api/work-entries', authenticate, async (req, res) => {
  try {
    const entries = await db.getWorkEntriesByUser(req.user.email);
    res.json(entries);
  } catch (error) {
    console.error('Get work entries error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/work-entries/:id', authenticate, async (req, res) => {
  try {
    const entry = await db.getWorkEntryById(req.params.id);
    if (!entry || entry.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Work entry not found' });
    }
    res.json(entry);
  } catch (error) {
    console.error('Get work entry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/work-entries', authenticate, async (req, res) => {
  try {
    const { error, value } = schemas.workEntry.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Verify client belongs to user
    const client = await db.getClientById(value.client_id);
    if (!client || client.user_email !== req.user.email) {
      return res.status(400).json({ error: 'Invalid client' });
    }

    const entry = await db.createWorkEntry({ ...value, user_email: req.user.email });
    res.status(201).json(entry);
  } catch (error) {
    console.error('Create work entry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/work-entries/:id', authenticate, async (req, res) => {
  try {
    const existing = await db.getWorkEntryById(req.params.id);
    if (!existing || existing.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    const { error, value } = schemas.workEntry.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Verify client belongs to user
    const client = await db.getClientById(value.client_id);
    if (!client || client.user_email !== req.user.email) {
      return res.status(400).json({ error: 'Invalid client' });
    }

    const entry = await db.updateWorkEntry(req.params.id, value);
    res.json(entry);
  } catch (error) {
    console.error('Update work entry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/work-entries/:id', authenticate, async (req, res) => {
  try {
    const existing = await db.getWorkEntryById(req.params.id);
    if (!existing || existing.user_email !== req.user.email) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    await db.deleteWorkEntry(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Delete work entry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export for Lambda
module.exports.handler = serverless(app);

// Export app for local testing
module.exports.app = app;
