/**
 * Local development server for testing the Lambda function locally
 * 
 * Uses SQLite in-memory database (no cloud dependencies)
 * 
 * Usage: npm start
 */

// Force SQLite mode for local development
process.env.DB_MODE = 'sqlite';

const { app } = require('./lambda');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Local server running on http://localhost:${PORT}`);
  console.log(`📊 Database mode: SQLite (in-memory)`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('No cloud dependencies required for local testing!');
});
