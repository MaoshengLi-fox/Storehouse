import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STORAGE_ROOT = path.resolve(process.cwd(), '.factory-server-data');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function moveLegacyBusinessDbIfNeeded(rootDir, businessDir) {
  const legacyDbPath = path.join(rootDir, 'factory-desk.db');
  const legacyWalPath = `${legacyDbPath}-wal`;
  const legacyShmPath = `${legacyDbPath}-shm`;

  const targetDbPath = path.join(businessDir, 'factory-desk.db');
  const targetWalPath = `${targetDbPath}-wal`;
  const targetShmPath = `${targetDbPath}-shm`;

  if (!fs.existsSync(legacyDbPath) || fs.existsSync(targetDbPath)) {
    return;
  }

  fs.renameSync(legacyDbPath, targetDbPath);

  if (fs.existsSync(legacyWalPath)) {
    fs.renameSync(legacyWalPath, targetWalPath);
  }

  if (fs.existsSync(legacyShmPath)) {
    fs.renameSync(legacyShmPath, targetShmPath);
  }
}

export function initializeStorageLayout(rawRootDir) {
  const rootDir = path.resolve(rawRootDir || DEFAULT_STORAGE_ROOT);

  const businessDir = ensureDir(path.join(rootDir, 'business'));
  const authDir = ensureDir(path.join(rootDir, 'auth'));
  const backupsDir = ensureDir(path.join(rootDir, 'backups'));
  const exportsDir = ensureDir(path.join(rootDir, 'exports'));

  moveLegacyBusinessDbIfNeeded(rootDir, businessDir);

  return {
    rootDir,
    businessDir,
    authDir,
    backupsDir,
    exportsDir
  };
}
