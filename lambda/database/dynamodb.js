const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  UpdateCommand, 
  DeleteCommand, 
  QueryCommand, 
  ScanCommand 
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLES = {
  users: process.env.USERS_TABLE || 'client-timesheet-app-users',
  clients: process.env.CLIENTS_TABLE || 'client-timesheet-app-clients',
  workEntries: process.env.WORK_ENTRIES_TABLE || 'client-timesheet-app-work-entries'
};

// Users
async function getUser(email) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.users,
    Key: { email }
  }));
  return result.Item;
}

async function createUser(email) {
  const user = {
    email,
    created_at: new Date().toISOString()
  };
  await docClient.send(new PutCommand({
    TableName: TABLES.users,
    Item: user
  }));
  return user;
}

// Clients
async function getClientsByUser(userEmail) {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLES.clients,
    IndexName: 'user_email-index',
    KeyConditionExpression: 'user_email = :email',
    ExpressionAttributeValues: { ':email': userEmail }
  }));
  return result.Items || [];
}

async function getClientById(id) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.clients,
    Key: { id }
  }));
  return result.Item;
}

async function createClient(data) {
  const client = {
    id: uuidv4(),
    name: data.name,
    description: data.description || null,
    department: data.department || null,
    email: data.email || null,
    user_email: data.user_email,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await docClient.send(new PutCommand({
    TableName: TABLES.clients,
    Item: client
  }));
  return client;
}

async function updateClient(id, data) {
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  if (data.name !== undefined) {
    updateExpressions.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = data.name;
  }
  if (data.description !== undefined) {
    updateExpressions.push('description = :description');
    expressionAttributeValues[':description'] = data.description;
  }
  if (data.department !== undefined) {
    updateExpressions.push('department = :department');
    expressionAttributeValues[':department'] = data.department;
  }
  if (data.email !== undefined) {
    updateExpressions.push('email = :email');
    expressionAttributeValues[':email'] = data.email;
  }

  updateExpressions.push('updated_at = :updated_at');
  expressionAttributeValues[':updated_at'] = new Date().toISOString();

  const result = await docClient.send(new UpdateCommand({
    TableName: TABLES.clients,
    Key: { id },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  }));
  return result.Attributes;
}

async function deleteClient(id) {
  await docClient.send(new DeleteCommand({
    TableName: TABLES.clients,
    Key: { id }
  }));
  // Also delete associated work entries
  const entries = await getWorkEntriesByClient(id);
  for (const entry of entries) {
    await deleteWorkEntry(entry.id);
  }
}

// Work Entries
async function getWorkEntriesByUser(userEmail) {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLES.workEntries,
    IndexName: 'user_email-index',
    KeyConditionExpression: 'user_email = :email',
    ExpressionAttributeValues: { ':email': userEmail }
  }));
  return result.Items || [];
}

async function getWorkEntriesByClient(clientId) {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLES.workEntries,
    IndexName: 'client_id-index',
    KeyConditionExpression: 'client_id = :clientId',
    ExpressionAttributeValues: { ':clientId': clientId }
  }));
  return result.Items || [];
}

async function getWorkEntryById(id) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLES.workEntries,
    Key: { id }
  }));
  return result.Item;
}

async function createWorkEntry(data) {
  const entry = {
    id: uuidv4(),
    client_id: data.client_id,
    user_email: data.user_email,
    hours: data.hours,
    description: data.description || null,
    date: data.date,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await docClient.send(new PutCommand({
    TableName: TABLES.workEntries,
    Item: entry
  }));
  return entry;
}

async function updateWorkEntry(id, data) {
  const updateExpressions = [];
  const expressionAttributeValues = {};

  if (data.hours !== undefined) {
    updateExpressions.push('hours = :hours');
    expressionAttributeValues[':hours'] = data.hours;
  }
  if (data.description !== undefined) {
    updateExpressions.push('description = :description');
    expressionAttributeValues[':description'] = data.description;
  }
  if (data.date !== undefined) {
    updateExpressions.push('#date = :date');
    expressionAttributeValues[':date'] = data.date;
  }
  if (data.client_id !== undefined) {
    updateExpressions.push('client_id = :client_id');
    expressionAttributeValues[':client_id'] = data.client_id;
  }

  updateExpressions.push('updated_at = :updated_at');
  expressionAttributeValues[':updated_at'] = new Date().toISOString();

  const result = await docClient.send(new UpdateCommand({
    TableName: TABLES.workEntries,
    Key: { id },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: data.date !== undefined ? { '#date': 'date' } : undefined,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  }));
  return result.Attributes;
}

async function deleteWorkEntry(id) {
  await docClient.send(new DeleteCommand({
    TableName: TABLES.workEntries,
    Key: { id }
  }));
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
  deleteWorkEntry
};
