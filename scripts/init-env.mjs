import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const generatedEnvKeys = {
  POSTGRES_PASSWORD: () => randomBytes(32).toString('hex'),
  MINIO_ROOT_USER: () => randomBytes(10).toString('hex'),
  MINIO_ROOT_PASSWORD: () => randomBytes(32).toString('hex'),
  PROVIDER_SECRET_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  READER_AUTH_TOKEN: () => randomBytes(32).toString('hex'),
  SUWAYOMI_AUTH_PASSWORD: () => randomBytes(32).toString('hex'),
  TEXT_SOURCE_SERVER_KEY: () => randomBytes(32).toString('hex'),
};
const persistentKeys = [
  'POSTGRES_PASSWORD',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'PROVIDER_SECRET_ENCRYPTION_KEY',
];

function emptyValue(raw) {
  const value = raw.trim();
  return !value || value.startsWith('#') || /^(?:"\s*"|'\s*')\s*(?:#.*)?$/.test(value);
}

/** Preserve existing assignments verbatim, including quotes, substitutions and comments. */
export function initializeEnv(directory, { newInstall = false } = {}) {
  const target = path.join(directory, '.env');
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('.env는 일반 파일이어야 합니다.');
  const existing = existsSync(target);
  const original = readFileSync(existing ? target : path.join(directory, '.env.example'), 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const assignments = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !Object.hasOwn(generatedEnvKeys, match[1])) return;
    if (assignments.has(match[1])) throw new Error(`${match[1]} 항목이 중복되어 있습니다. 먼저 하나로 정리하세요.`);
    assignments.set(match[1], { index, empty: emptyValue(match[2]) });
  });
  const needsValue = (key) => !assignments.has(key) || assignments.get(key).empty;
  if (existing && !newInstall && persistentKeys.some(needsValue)) {
    throw new Error(
      '기존 .env의 저장소 비밀번호 또는 암호화 키가 비어 있어 변경하지 않았습니다. 기존 설치는 현재 설정과 볼륨 키를 유지하세요. 아직 볼륨을 만들지 않은 새 설치만 --new-install로 실행하세요.',
    );
  }
  const generated = [];
  for (const [key, generate] of Object.entries(generatedEnvKeys)) {
    if (!needsValue(key)) continue;
    const assignment = `${key}=${generate()}`;
    const previous = assignments.get(key);
    if (previous) lines[previous.index] = assignment;
    else lines.push(assignment);
    generated.push(key);
  }
  const content = lines.join(eol);
  if (!existing || content !== original) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  chmodSync(target, 0o600);
  return { generated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--new-install'))
      throw new Error('사용법: node scripts/init-env.mjs [--new-install]');
    initializeEnv(process.cwd(), { newInstall: process.argv.includes('--new-install') });
    console.log('.env 준비 완료. 기존 값은 보존했으며 파일 권한은 600으로 설정했습니다.');
    console.log(
      '처음 접속한 뒤 docker compose logs api 에서 일회용 설정 코드를 확인하세요. READER_AUTH_TOKEN은 복구용으로 생성하며 .env를 안전하게 보관하세요.',
    );
    console.log('비밀값은 출력하지 않습니다. Windows에서는 .env의 파일 접근 권한도 확인하세요.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : '환경 파일 초기화에 실패했습니다.');
    process.exitCode = 1;
  }
}
