import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { HttpError, MAX_FILE_BYTES, safeFilename } from './core.mjs';

const config = { region: process.env.AWS_REGION, maxAttempts: 3 };
export const s3 = new S3Client(config);
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(config), { marshallOptions: { removeUndefinedValues: true } });
const Bucket = process.env.MAIL_BUCKET;
const TableName = process.env.MAIL_TABLE;
export const putObject = (Key, Body, ContentType = 'application/octet-stream') => s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
export async function readObject(Key) {
  const result = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await result.Body.transformToByteArray());
}
export async function headObject(Key) { return s3.send(new HeadObjectCommand({ Bucket, Key })); }
export async function getMail(id) {
  const { Item } = await db.send(new GetCommand({ TableName, Key: { id }, ConsistentRead: true }));
  if (!Item) throw new HttpError(404, 'Message not found.');
  return Item;
}
export const putMail = Item => db.send(new PutCommand({ TableName, Item, ConditionExpression: 'attribute_not_exists(id)' }));
export async function updateMail(id, patch) {
  const entries = Object.entries(patch);
  const result = await db.send(new UpdateCommand({
    TableName, Key: { id }, ConditionExpression: 'attribute_exists(id)',
    UpdateExpression: 'SET ' + entries.map((_, i) => `#n${i} = :v${i}`).join(', '),
    ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#n${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
    ReturnValues: 'ALL_NEW'
  }));
  return result.Attributes;
}
export async function listMail(folder, cursor) {
  return db.send(new QueryCommand({ TableName, IndexName: 'ByFolder',
    KeyConditionExpression: '#folder = :folder', ExpressionAttributeNames: { '#folder': 'folder' },
    ExpressionAttributeValues: { ':folder': folder }, ScanIndexForward: false, Limit: 50, ExclusiveStartKey: cursor
  }));
}
export async function downloadUrl(key, filename) {
  const name = safeFilename(filename);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key,
    ResponseContentType: 'application/octet-stream',
    ResponseContentDisposition: `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
  }), { expiresIn: 120 });
}
export async function uploadForm(key) {
  return createPresignedPost(s3, { Bucket, Key: key, Expires: 300,
    Conditions: [['content-length-range', 1, MAX_FILE_BYTES]],
    Fields: { 'Content-Type': 'application/octet-stream' }
  });
}
