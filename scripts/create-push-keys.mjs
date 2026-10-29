// Creates the Web Push VAPID key pair in Secrets Manager, once. Prints only the secret ARN;
// the private key never leaves AWS. Re-running leaves an existing secret untouched, because
// replacing the keys would silently break every enrolled device.
import { readFile } from 'node:fs/promises';
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import webpush from 'web-push';

const config = JSON.parse(await readFile(new URL('../production/config.json', import.meta.url)));
process.env.AWS_PROFILE ||= config.profile;
const secrets = new SecretsManagerClient({ region: config.region }), Name = `${config.stackPrefix}/push-vapid`;
let arn;
try { arn = (await secrets.send(new DescribeSecretCommand({ SecretId: Name }))).ARN; console.log(`Existing VAPID secret kept: ${arn}`); }
catch (error) {
  if (error.name !== 'ResourceNotFoundException') throw error;
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  arn = (await secrets.send(new CreateSecretCommand({ Name, Description: 'Inbox Web Push VAPID key pair (publicKey, privateKey, subject)', SecretString: JSON.stringify({ publicKey, privateKey, subject: `mailto:${config.ownerEmail}` }),
    Tags: [{ Key: 'Project', Value: 'project-inbox' }, { Key: 'Environment', Value: 'production' }] }))).ARN;
  console.log(`Created VAPID secret: ${arn}`);
}
if (!arn.startsWith(`arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:`)) throw new Error('Unexpected secret ARN');
