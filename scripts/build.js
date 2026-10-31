import { mkdir, cp, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/assets', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('src/assets/house-energy.png', 'dist/assets/house-energy.png');
console.log('Dashboard gebouwd in dist/');
