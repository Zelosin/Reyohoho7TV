import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(root, 'src', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const sevenTvResponse = await fetch('https://7tv.io/v3/emote-sets/global');
const sevenTvData = await sevenTvResponse.json();
const sevenTvFallback = {};

for (const entry of sevenTvData.emotes ?? []) {
  const id = entry.id ?? entry.data?.id;
  const host = entry.data?.host?.url ?? '';
  const url = host
    ? `https:${host}/2x.webp`
    : `https://cdn.7tv.app/emote/${id}/2x.webp`;
  sevenTvFallback[entry.name] = url;
}

fs.writeFileSync(
  path.join(dataDir, 'seventv-emotes-fallback.json'),
  JSON.stringify(sevenTvFallback)
);

console.log('7TV fallback emotes:', Object.keys(sevenTvFallback).length);
