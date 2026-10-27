import { readFile } from 'node:fs/promises';
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createStageHandler } from './auth.mjs';
import { verifyGoogleToken } from './google.mjs';

const region = process.env.AWS_REGION;
const dynamo = new DynamoDBClient({ region, maxAttempts: 2 });
const secrets = new SecretsManagerClient({ region, maxAttempts: 2 });
const TableName = process.env.AUTH_TABLE;
const marshal = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === 'number' ? { N: String(value) } : typeof value === 'boolean' ? { BOOL: value } : { S: value }]));
const unmarshal = record => record && Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.S ?? (value.N !== undefined ? Number(value.N) : value.BOOL)]));
const store = {
  async get(pk) { return unmarshal((await dynamo.send(new GetItemCommand({ TableName, Key: { pk: { S: pk } }, ConsistentRead: true }))).Item); },
  async put(record) { await dynamo.send(new PutItemCommand({ TableName, Item: marshal(record) })); },
  async remove(pk) { await dynamo.send(new DeleteItemCommand({ TableName, Key: { pk: { S: pk } } })); },
  async takeLogin(pk, binding, now) {
    try {
      const result = await dynamo.send(new DeleteItemCommand({ TableName, Key: { pk: { S: pk } }, ConditionExpression: '#binding = :binding AND expiresAt > :now', ExpressionAttributeNames: { '#binding': 'binding' }, ExpressionAttributeValues: { ':binding': { S: binding }, ':now': { N: String(now) } }, ReturnValues: 'ALL_OLD' }));
      return unmarshal(result.Attributes);
    } catch (error) { if (error.name === 'ConditionalCheckFailedException') return null; throw error; }
  },
  async pinOwner(record) {
    try { await dynamo.send(new PutItemCommand({ TableName, Item: marshal(record), ConditionExpression: 'attribute_not_exists(pk)' })); return record; }
    catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; return this.get('owner'); }
  },
};
let client, loadedAt = 0;
async function getGoogleClient() {
  if (!client || Date.now() - loadedAt > 300_000) {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.GOOGLE_SECRET_ARN }));
    const value = JSON.parse(secret.SecretString);
    if (!value.clientId?.endsWith('.apps.googleusercontent.com') || typeof value.clientSecret !== 'string' || !value.clientSecret) throw new Error('InvalidOAuthConfiguration');
    client = { clientId: value.clientId, clientSecret: value.clientSecret }; loadedAt = Date.now();
  }
  return client;
}
async function exchangeCode({ code, verifier, callback, clientId, clientSecret }) {
  const result = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, code_verifier: verifier, redirect_uri: callback, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(7000) });
  if (!result.ok) throw new Error('GoogleTokenExchangeFailed');
  const value = await result.json(); if (typeof value.id_token !== 'string') throw new Error('MissingIdToken');
  return value.id_token;
}
const manifest = JSON.parse(await readFile(new URL('./assets-manifest.json', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const cachedAssets = new Map();
async function asset(path) {
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!Object.hasOwn(manifest, name)) return null;
  if (!cachedAssets.has(name)) {
    const bytes = await readFile(new URL(`./assets/${name}`, import.meta.url));
    cachedAssets.set(name, { body: bytes.toString('base64'), base64: true, type: mime[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
  }
  return cachedAssets.get(name);
}
export const handler = createStageHandler({ origin: process.env.PUBLIC_ORIGIN, ownerEmail: process.env.OWNER_EMAIL, store, getGoogleClient, exchangeCode, verifyGoogleToken, asset, log: data => console.error('stage-request-failed', data) });
