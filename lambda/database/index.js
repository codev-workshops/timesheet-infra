/**
 * Database abstraction layer
 * 
 * Supports two modes:
 * - 'sqlite': Local development with SQLite in-memory database
 * - 'dynamodb': Cloud deployment with AWS DynamoDB
 * 
 * Set DB_MODE environment variable to switch between modes.
 * Default: 'sqlite' for local development
 */

const DB_MODE = process.env.DB_MODE || 'sqlite';

let db;

if (DB_MODE === 'dynamodb') {
  db = require('./dynamodb');
} else {
  db = require('./sqlite');
}

module.exports = db;
