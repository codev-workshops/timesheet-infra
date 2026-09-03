# Lambda Function - Client Timesheet App API

This is the serverless backend for the Client Timesheet App, designed to run on AWS Lambda with API Gateway.

## Database Modes

The application supports two database modes controlled by the `DB_MODE` environment variable:

| Mode | Database | Use Case | Cloud Dependencies |
|------|----------|----------|-------------------|
| `sqlite` | SQLite in-memory | Local development | **None** |
| `dynamodb` | AWS DynamoDB | Cloud deployment | AWS credentials |

## Local Development (No Cloud Dependencies)

```bash
# Install dependencies
npm install

# Start local server (uses SQLite automatically)
npm start
```

The server runs at `http://localhost:3001` with:
- SQLite in-memory database
- No AWS credentials required
- Full API compatibility with cloud version

### Test the API

```bash
# Health check
curl http://localhost:3001/health

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
```

## Cloud Deployment (Lambda + DynamoDB)

### Environment Variables

Set these in Lambda configuration:

```
DB_MODE=dynamodb
USERS_TABLE=client-timesheet-app-users
CLIENTS_TABLE=client-timesheet-app-clients
WORK_ENTRIES_TABLE=client-timesheet-app-work-entries
JWT_SECRET=your-production-secret
```

### Deploy to Lambda

```bash
# Install production dependencies
npm install --production

# Create deployment package
zip -r lambda.zip .

# Update Lambda function
aws lambda update-function-code \
  --function-name client-timesheet-app-api \
  --zip-file fileb://lambda.zip
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/api/auth/login` | Login with email |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/clients` | List clients |
| POST | `/api/clients` | Create client |
| GET | `/api/clients/:id` | Get client |
| PUT | `/api/clients/:id` | Update client |
| DELETE | `/api/clients/:id` | Delete client |
| GET | `/api/work-entries` | List work entries |
| POST | `/api/work-entries` | Create work entry |
| GET | `/api/work-entries/:id` | Get work entry |
| PUT | `/api/work-entries/:id` | Update work entry |
| DELETE | `/api/work-entries/:id` | Delete work entry |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    lambda.js                             │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Express App                         │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐           │    │
│  │  │  Auth   │ │ Clients │ │  Work   │           │    │
│  │  │ Routes  │ │ Routes  │ │ Entries │           │    │
│  │  └────┬────┘ └────┬────┘ └────┬────┘           │    │
│  │       │           │           │                 │    │
│  │       └───────────┼───────────┘                 │    │
│  │                   ▼                             │    │
│  │         ┌─────────────────┐                     │    │
│  │         │ database/index  │                     │    │
│  │         │   (abstraction) │                     │    │
│  │         └────────┬────────┘                     │    │
│  │                  │                              │    │
│  │     ┌────────────┴────────────┐                 │    │
│  │     ▼                         ▼                 │    │
│  │ ┌──────────┐           ┌──────────┐            │    │
│  │ │  SQLite  │           │ DynamoDB │            │    │
│  │ │ (local)  │           │ (cloud)  │            │    │
│  │ └──────────┘           └──────────┘            │    │
│  └─────────────────────────────────────────────────┘    │
│                         │                                │
│                         ▼                                │
│               serverless-http wrapper                    │
│                         │                                │
│                         ▼                                │
│                  Lambda Handler                          │
└─────────────────────────────────────────────────────────┘
```
