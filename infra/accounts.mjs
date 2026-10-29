// Deployment identity (AWS account IDs, CLI profiles, owner address).
// Real values live in accounts.json at the repository root, which is gitignored;
// accounts.example.json documents the shape and keeps tests and templates runnable.
import { existsSync, readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const source = ['accounts.json', 'accounts.example.json'].map(name => new URL(name, root)).find(url => existsSync(url));
export const accounts = JSON.parse(readFileSync(source, 'utf8'));
export const usingExampleAccounts = !source.pathname.endsWith('/accounts.json');
