import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await cp('web', 'dist', { recursive: true });
console.log('Local prototype copied to dist. This is not a production mail deployment.');
