/**
 * SQLite database adapter for local development
 * Mirrors the DynamoDB interface for seamless switching
 */

const sqlite3 = require('sqlite3').verbose();

let db = null;
let initialized = false;

function getDatabase() {
  if (!db) {
    db = new sqlite3.Database(':memory:', (err) => {
      if (err) {
        console.error('Error opening database:', err);
        throw err;
      }
      console.log('Connected to SQLite in-memory database');
    });
  }
  return db;
}

async function initializeDatabase() {
  if (initialized) return;
  
  const database = getDatabase();
  
  return new Promise((resolve, reject) => {
    database.serialize(() => {
      database.run(`
        CREATE TABLE IF NOT EXISTS users (
          email TEXT PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      database.run(`
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          department TEXT,
          email TEXT,
          user_email TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      database.run(`
        CREATE TABLE IF NOT EXISTS work_entries (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          user_email TEXT NOT NULL,
          hours DECIMAL(5,2) NOT NULL,
          description TEXT,
          date DATE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      database.run(`CREATE INDEX IF NOT EXISTS idx_clients_user_email ON clients (user_email)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_client_id ON work_entries (client_id)`);
      database.run(`CREATE INDEX IF NOT EXISTS idx_work_entries_user_email ON work_entries (user_email)`, () => {
        initialized = true;
        resolve();
      });
    });
  });
}

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Users
async function getUser(email) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function createUser(email) {
  await initializeDatabase();
  const created_at = new Date().toISOString();
  return new Promise((resolve, reject) => {
    getDatabase().run('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)', [email, created_at], function(err) {
      if (err) reject(err);
      else resolve({ email, created_at });
    });
  });
}

// Clients
async function getClientsByUser(userEmail) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().all('SELECT * FROM clients WHERE user_email = ?', [userEmail], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function getClientById(id) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().get('SELECT * FROM clients WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function createClient(data) {
  await initializeDatabase();
  const id = generateId();
  const now = new Date().toISOString();
  const client = {
    id,
    name: data.name,
    description: data.description || null,
    department: data.department || null,
    email: data.email || null,
    user_email: data.user_email,
    created_at: now,
    updated_at: now
  };
  
  return new Promise((resolve, reject) => {
    getDatabase().run(
      'INSERT INTO clients (id, name, description, department, email, user_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [client.id, client.name, client.description, client.department, client.email, client.user_email, client.created_at, client.updated_at],
      function(err) {
        if (err) reject(err);
        else resolve(client);
      }
    );
  });
}

async function updateClient(id, data) {
  await initializeDatabase();
  const updates = [];
  const values = [];
  
  if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
  if (data.department !== undefined) { updates.push('department = ?'); values.push(data.department); }
  if (data.email !== undefined) { updates.push('email = ?'); values.push(data.email); }
  
  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  return new Promise((resolve, reject) => {
    getDatabase().run(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
      if (err) reject(err);
      else getClientById(id).then(resolve).catch(reject);
    });
  });
}

async function deleteClient(id) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().serialize(() => {
      getDatabase().run('DELETE FROM work_entries WHERE client_id = ?', [id]);
      getDatabase().run('DELETE FROM clients WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// Work Entries
async function getWorkEntriesByUser(userEmail) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().all('SELECT * FROM work_entries WHERE user_email = ?', [userEmail], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function getWorkEntriesByClient(clientId) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().all('SELECT * FROM work_entries WHERE client_id = ?', [clientId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function getWorkEntryById(id) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().get('SELECT * FROM work_entries WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function createWorkEntry(data) {
  await initializeDatabase();
  const id = generateId();
  const now = new Date().toISOString();
  const entry = {
    id,
    client_id: data.client_id,
    user_email: data.user_email,
    hours: data.hours,
    description: data.description || null,
    date: data.date,
    created_at: now,
    updated_at: now
  };
  
  return new Promise((resolve, reject) => {
    getDatabase().run(
      'INSERT INTO work_entries (id, client_id, user_email, hours, description, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [entry.id, entry.client_id, entry.user_email, entry.hours, entry.description, entry.date, entry.created_at, entry.updated_at],
      function(err) {
        if (err) reject(err);
        else resolve(entry);
      }
    );
  });
}

async function updateWorkEntry(id, data) {
  await initializeDatabase();
  const updates = [];
  const values = [];
  
  if (data.hours !== undefined) { updates.push('hours = ?'); values.push(data.hours); }
  if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
  if (data.date !== undefined) { updates.push('date = ?'); values.push(data.date); }
  if (data.client_id !== undefined) { updates.push('client_id = ?'); values.push(data.client_id); }
  
  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  return new Promise((resolve, reject) => {
    getDatabase().run(`UPDATE work_entries SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
      if (err) reject(err);
      else getWorkEntryById(id).then(resolve).catch(reject);
    });
  });
}

async function deleteWorkEntry(id) {
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    getDatabase().run('DELETE FROM work_entries WHERE id = ?', [id], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  getUser,
  createUser,
  getClientsByUser,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getWorkEntriesByUser,
  getWorkEntriesByClient,
  getWorkEntryById,
  createWorkEntry,
  updateWorkEntry,
  deleteWorkEntry,
  initializeDatabase
};
