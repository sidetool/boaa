import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

const PASSWORD_SCHEME = 'scrypt-v1' as const;
const PASSWORD_KEY_BYTES = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 8;
const MAX_LOGIN_FAILURE_KEYS = 1_000;

export interface SelfHostAccountView {
  readonly userId: string;
  readonly role: 'admin' | 'member';
  readonly sessionContext?: string;
  readonly authVersion?: number;
  readonly status?: 'active' | 'invited' | 'disabled';
  readonly username: string;
  readonly displayName: string;
}

interface StoredSelfHostAccount extends SelfHostAccountView {
  readonly userId: string;
  readonly normalizedUsername: string;
  readonly passwordSalt: string;
  readonly passwordDigest: string;
}

export interface SelfHostSessionView {
  readonly token: string;
  readonly expiresAt: string;
  readonly account: SelfHostAccountView;
}

export interface RegisterSelfHostAccountInput {
  readonly username: string;
  readonly displayName?: string;
  readonly password: string;
}

export interface LoginSelfHostAccountInput {
  readonly username: string;
  readonly password: string;
  readonly throttleKey: string;
}

export class SelfHostAuthError extends Error {
  constructor(
    public readonly code:
      | 'account_already_registered'
      | 'invalid_credentials'
      | 'invalid_display_name'
      | 'invalid_password'
      | 'invalid_username'
      | 'login_rate_limited'
      | 'setup_rate_limited'
      | 'invalid_setup_code'
      | 'invalid_token'
      | 'account_not_found'
      | 'protected_account'
      | 'username_unavailable',
    public readonly status: number,
  ) {
    super(code);
    this.name = 'SelfHostAuthError';
  }
}

export interface SelfHostAuthStore {
  loadAccount(normalizedUsername?: string): Promise<StoredSelfHostAccount | undefined>;
  createAccount(account: StoredSelfHostAccount): Promise<boolean>;
  updateUserDisplayName(userId: string, displayName: string): Promise<void>;
  createSession(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    authVersion?: number,
    sessionContext?: string,
  ): Promise<void>;
  resolveSession(tokenHash: string, now: string): Promise<StoredSelfHostAccount | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<void>;
}

interface LoginFailures {
  count: number;
  startedAt: number;
}

let activeHashes = 0;
function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 4) return Promise.reject(new SelfHostAuthError('login_rate_limited', 429));
  activeHashes += 1;
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, key) => {
        activeHashes -= 1;
        if (error) reject(error);
        else resolve(key as Buffer);
      },
    );
  });
}

function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function validatedUsername(value: string): { username: string; normalized: string } {
  const username = value.trim().normalize('NFKC');
  const normalized = normalizeUsername(username);
  if (
    username.length < 2 ||
    username.length > 64 ||
    !/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$/u.test(username)
  ) {
    throw new SelfHostAuthError('invalid_username', 400);
  }
  return { username, normalized };
}

function validatedDisplayName(value: string | undefined, fallback: string): string {
  const displayName = (value ?? fallback).trim().normalize('NFKC');
  const hasControlCharacter = [...displayName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!displayName || displayName.length > 80 || hasControlCharacter) {
    throw new SelfHostAuthError('invalid_display_name', 400);
  }
  return displayName;
}

function validatedPassword(value: string): string {
  if (value.length < 10 || value.length > 256) throw new SelfHostAuthError('invalid_password', 400);
  return value;
}

async function passwordDigest(password: string, saltBase64: string): Promise<string> {
  const digest = await scrypt(password, Buffer.from(saltBase64, 'base64'));
  return digest.toString('base64');
}

function safeDigestEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64');
  const rightBuffer = Buffer.from(right, 'base64');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function selfHostSessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SelfHostAuthService {
  private readonly loginFailures = new Map<string, LoginFailures>();

  constructor(
    private readonly store: SelfHostAuthStore,
    private readonly defaultUserId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(sessionToken?: string): Promise<{
    setupRequired: boolean;
    authenticated: boolean;
    account?: SelfHostAccountView;
  }> {
    const account = await this.loadOwnedAccount();
    if (!account) return { setupRequired: true, authenticated: false };
    const authenticated = sessionToken ? await this.authenticateSession(sessionToken) : undefined;
    return {
      setupRequired: false,
      authenticated: Boolean(authenticated),
      account: authenticated,
    };
  }

  async setupRequired(): Promise<boolean> {
    return !(await this.loadOwnedAccount());
  }

  async register(input: RegisterSelfHostAccountInput): Promise<SelfHostSessionView> {
    const { username, normalized } = validatedUsername(input.username);
    const displayName = validatedDisplayName(input.displayName, username);
    const password = validatedPassword(input.password);
    const salt = randomBytes(16).toString('base64');
    const digest = await passwordDigest(password, salt);
    const account: StoredSelfHostAccount = {
      userId: this.defaultUserId,
      role: 'admin',
      authVersion: 1,
      status: 'active',
      username,
      normalizedUsername: normalized,
      displayName,
      passwordSalt: salt,
      passwordDigest: digest,
    };
    if (!(await this.store.createAccount(account))) {
      throw new SelfHostAuthError('account_already_registered', 409);
    }
    await this.store.updateUserDisplayName(this.defaultUserId, displayName);
    return this.issueSession(account);
  }

  async login(input: LoginSelfHostAccountInput): Promise<SelfHostSessionView> {
    const throttleKey = input.throttleKey.slice(0, 200);
    this.assertLoginAllowed(throttleKey);
    const normalized = normalizeUsername(input.username.slice(0, 256));
    this.assertLoginAllowed(`account:${normalized}`);
    this.assertLoginAllowed('global-login');
    const account = await this.store.loadAccount(normalized);
    const passwordInRange = input.password.length > 0 && input.password.length <= 256;
    const digest = await passwordDigest(
      passwordInRange ? input.password : 'invalid-password',
      account?.passwordSalt || 'AAAAAAAAAAAAAAAAAAAAAA==',
    );
    if (
      !account ||
      (account.status && account.status !== 'active') ||
      normalized !== account.normalizedUsername ||
      !digest ||
      !safeDigestEquals(digest, account.passwordDigest)
    ) {
      this.recordLoginFailure(throttleKey);
      this.recordLoginFailure(`account:${normalized}`);
      this.recordLoginFailure('global-login');
      throw new SelfHostAuthError('invalid_credentials', 401);
    }
    this.loginFailures.delete(throttleKey);
    return this.issueSession(account);
  }

  async authenticateSession(token: string | undefined): Promise<SelfHostAccountView | undefined> {
    if (!token || token.length > 512) return undefined;
    await this.loadOwnedAccount();
    const account = await this.store.resolveSession(selfHostSessionTokenHash(token), this.now().toISOString());
    return account
      ? {
          userId: account.userId,
          role: account.role,
          username: account.username,
          displayName: account.displayName,
          sessionContext: account.sessionContext,
          authVersion: account.authVersion,
        }
      : undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || token.length > 512) return;
    await this.store.revokeSession(selfHostSessionTokenHash(token));
  }

  private adminStore(): PostgresSelfHostAuthStore {
    if (!(this.store instanceof PostgresSelfHostAuthStore)) throw new Error('account_administration_unavailable');
    return this.store;
  }
  async ownerRecovery(key: string) {
    this.assertLoginAllowed(`recovery:${key.slice(0, 200)}`);
    this.assertLoginAllowed('global-recovery');
    this.recordLoginFailure(`recovery:${key.slice(0, 200)}`);
    this.recordLoginFailure('global-recovery');
    await this.loadOwnedAccount();
    return this.adminStore().issueAccountToken(this.defaultUserId, this.defaultUserId, 'password-reset');
  }
  async listAccounts() {
    return this.adminStore().listAccounts();
  }
  async invite(actorId: string, usernameInput: string, displayNameInput?: string) {
    const { username, normalized } = validatedUsername(usernameInput);
    const displayName = validatedDisplayName(displayNameInput, username);
    return this.adminStore().createInvitation(actorId, { username, normalized, displayName });
  }
  async issueAccountToken(actorId: string, userId: string, purpose: 'invite' | 'password-reset') {
    return this.adminStore().issueAccountToken(actorId, userId, purpose);
  }
  async updateAccount(userId: string, input: { displayName?: string; enabled?: boolean }) {
    return this.adminStore().updateAccount(userId, {
      ...input,
      ...(input.displayName !== undefined ? { displayName: validatedDisplayName(input.displayName, '') } : {}),
    });
  }
  async revokeAll(userId: string) {
    await this.adminStore().revokeAll(userId);
  }
  async redeem(token: string, passwordInput: string, purpose: 'invite' | 'password-reset', key: string) {
    this.assertLoginAllowed(key);
    this.recordLoginFailure(key);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SelfHostAuthError('invalid_token', 400);
    const password = validatedPassword(passwordInput);
    const salt = randomBytes(16).toString('base64');
    const digest = await passwordDigest(password, salt);
    return this.adminStore().redeem(selfHostSessionTokenHash(token), purpose, salt, digest);
  }
  async changePassword(token: string, currentPassword: string, newPassword: string, key: string) {
    const current = await this.authenticateSession(token);
    if (!current) throw new SelfHostAuthError('invalid_credentials', 401);
    this.assertLoginAllowed(key);
    this.recordLoginFailure(key);
    const account = await this.store.loadAccount(normalizeUsername(current.username));
    if (
      !account ||
      !safeDigestEquals(
        await passwordDigest(currentPassword.slice(0, 256), account.passwordSalt),
        account.passwordDigest,
      )
    )
      throw new SelfHostAuthError('invalid_credentials', 401);
    const salt = randomBytes(16).toString('base64');
    const digest = await passwordDigest(validatedPassword(newPassword), salt);
    await this.adminStore().replacePassword(account.userId, account.authVersion ?? 1, salt, digest);
    return this.issueSession({
      ...account,
      passwordSalt: salt,
      passwordDigest: digest,
      authVersion: (account.authVersion ?? 1) + 1,
    });
  }

  private async issueSession(account: StoredSelfHostAccount): Promise<SelfHostSessionView> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const token = randomBytes(32).toString('base64url');
    await this.store.deleteExpiredSessions(now.toISOString());
    const sessionContext = randomBytes(24).toString('base64url');
    await this.store.createSession(
      account.userId,
      selfHostSessionTokenHash(token),
      expiresAt,
      account.authVersion ?? 1,
      sessionContext,
    );
    return {
      token,
      expiresAt,
      account: {
        userId: account.userId,
        role: account.role,
        username: account.username,
        displayName: account.displayName,
        sessionContext,
        authVersion: account.authVersion,
      },
    };
  }

  private async loadOwnedAccount(): Promise<StoredSelfHostAccount | undefined> {
    const account = await this.store.loadAccount();
    if (account && account.userId !== this.defaultUserId) throw new Error('self_host_account_owner_mismatch');
    return account;
  }

  private assertLoginAllowed(key: string): void {
    const now = this.now().getTime();
    this.pruneLoginFailures(now);
    const current = this.loginFailures.get(key);
    if (!current) return;
    if (now - current.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.delete(key);
      return;
    }
    if (current.count >= (key === 'global-login' ? 100 : LOGIN_FAILURE_LIMIT))
      throw new SelfHostAuthError('login_rate_limited', 429);
  }

  private recordLoginFailure(key: string): void {
    const now = this.now().getTime();
    this.pruneLoginFailures(now);
    const current = this.loginFailures.get(key);
    if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
      while (this.loginFailures.size >= MAX_LOGIN_FAILURE_KEYS) {
        this.loginFailures.delete(this.loginFailures.keys().next().value ?? '');
      }
      this.loginFailures.set(key, { count: 1, startedAt: now });
      return;
    }
    current.count += 1;
  }

  private pruneLoginFailures(now: number): void {
    for (const [key, failure] of this.loginFailures) {
      if (now - failure.startedAt >= LOGIN_WINDOW_MS) this.loginFailures.delete(key);
    }
  }
}

interface AccountRow {
  readonly user_id: string;
  readonly role: 'admin' | 'member';
  readonly status: 'active' | 'invited' | 'disabled';
  readonly auth_version: number;
  readonly session_context?: string;
  readonly username: string;
  readonly normalized_username: string;
  readonly display_name: string;
  readonly password_salt: string;
  readonly password_digest: string;
}

function mapAccount(row: AccountRow | undefined): StoredSelfHostAccount | undefined {
  return row
    ? {
        userId: row.user_id,
        role: row.role,
        status: row.status,
        authVersion: row.auth_version,
        sessionContext: row.session_context,
        username: row.username,
        normalizedUsername: row.normalized_username,
        displayName: row.display_name,
        passwordSalt: row.password_salt,
        passwordDigest: row.password_digest,
      }
    : undefined;
}

export class PostgresSelfHostAuthStore implements SelfHostAuthStore {
  constructor(private readonly pool: pg.Pool) {}

  async loadAccount(normalizedUsername?: string): Promise<StoredSelfHostAccount | undefined> {
    const result = await this.pool.query<AccountRow>(
      `select * from self_host_accounts where ($1::text is null and bootstrap_owner_key = 1) or normalized_username = $1`,
      [normalizedUsername ?? null],
    );
    return mapAccount(result.rows[0]);
  }

  async createAccount(account: StoredSelfHostAccount): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `insert into self_host_accounts
         (bootstrap_owner_key, user_id, username, normalized_username, display_name, password_scheme, password_salt, password_digest, role)
       values (1, $1, $2, $3, $4, $5, $6, $7, 'admin')
       on conflict (bootstrap_owner_key) do nothing`,
        [
          account.userId,
          account.username,
          account.normalizedUsername,
          account.displayName,
          PASSWORD_SCHEME,
          account.passwordSalt,
          account.passwordDigest,
        ],
      );
      if (result.rowCount === 1)
        await client.query('update users set display_name=$2,updated_at=now() where id=$1', [
          account.userId,
          account.displayName,
        ]);
      return result.rowCount === 1;
    });
  }

  async updateUserDisplayName(userId: string, displayName: string): Promise<void> {
    await this.pool.query(`update users set display_name = $2, updated_at = now() where id = $1`, [
      userId,
      displayName,
    ]);
  }

  async createSession(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    authVersion = 1,
    sessionContext?: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `insert into self_host_sessions (token_hash,user_id,expires_at,auth_version,session_context) select $1,user_id,$3::timestamptz,auth_version,coalesce($5,gen_random_uuid()::text) from self_host_accounts where user_id=$2 and status='active' and auth_version=$4 for update`,
      [tokenHash, userId, expiresAt, authVersion, sessionContext],
    );
    if (result.rowCount !== 1) throw new SelfHostAuthError('invalid_credentials', 401);
  }

  async resolveSession(tokenHash: string, now: string): Promise<StoredSelfHostAccount | undefined> {
    const result = await this.pool.query<AccountRow>(
      `select a.*, s.session_context
         from self_host_sessions s
         join self_host_accounts a on a.user_id = s.user_id and a.status = 'active' and a.auth_version = s.auth_version
        where s.token_hash = $1 and s.expires_at > $2::timestamptz`,
      [tokenHash, now],
    );
    return mapAccount(result.rows[0]);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query(`delete from self_host_sessions where token_hash = $1`, [tokenHash]);
  }

  private async transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await action(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      if ((error as { code?: string }).code === '23505') throw new SelfHostAuthError('username_unavailable', 409);
      throw error;
    } finally {
      client.release();
    }
  }
  async listAccounts() {
    const result = await this.pool.query(
      `select user_id as "userId",username,display_name as "displayName",role,status,created_at as "createdAt" from self_host_accounts order by created_at,user_id limit 200`,
    );
    return result.rows;
  }
  private async mint(client: pg.PoolClient, actor: string, userId: string, purpose: 'invite' | 'password-reset') {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + (purpose === 'invite' ? 48 : 1) * 3600000).toISOString();
    await client.query(
      `update self_host_account_tokens set revoked_at=now() where user_id=$1 and purpose=$2 and consumed_at is null and revoked_at is null`,
      [userId, purpose],
    );
    await client.query(
      `insert into self_host_account_tokens(token_hash,user_id,purpose,creator_user_id,expires_at) values($1,$2,$3,$4,$5)`,
      [selfHostSessionTokenHash(token), userId, purpose, actor, expiresAt],
    );
    return { token, expiresAt };
  }
  async createInvitation(actor: string, input: { username: string; normalized: string; displayName: string }) {
    return this.transaction(async (client) => {
      const userId = `user_${randomBytes(18).toString('hex')}`;
      await client.query('insert into users(id,display_name) values($1,$2)', [userId, input.displayName]);
      await client.query(
        `insert into self_host_accounts(user_id,username,normalized_username,display_name,role,status) values($1,$2,$3,$4,'member','invited')`,
        [userId, input.username, input.normalized, input.displayName],
      );
      const grant = await this.mint(client, actor, userId, 'invite');
      return {
        account: {
          userId,
          username: input.username,
          displayName: input.displayName,
          role: 'member',
          status: 'invited',
        },
        ...grant,
      };
    });
  }
  async issueAccountToken(actor: string, userId: string, purpose: 'invite' | 'password-reset') {
    return this.transaction(async (client) => {
      const result = await client.query('select * from self_host_accounts where user_id=$1 for update', [userId]);
      const account = result.rows[0];
      if (
        !account ||
        account.status === 'disabled' ||
        (purpose === 'invite' ? !!account.password_digest : !account.password_digest)
      )
        throw new SelfHostAuthError('account_not_found', 404);
      return this.mint(client, actor, userId, purpose);
    });
  }
  private async invalidate(client: pg.PoolClient, userId: string) {
    await client.query('update self_host_accounts set auth_version=auth_version+1,updated_at=now() where user_id=$1', [
      userId,
    ]);
    await client.query('delete from self_host_sessions where user_id=$1', [userId]);
  }
  async revokeAll(userId: string) {
    await this.transaction(async (client) => {
      await client.query('select user_id from self_host_accounts where user_id=$1 for update', [userId]);
      await this.invalidate(client, userId);
    });
  }
  async updateAccount(userId: string, input: { displayName?: string; enabled?: boolean }) {
    return this.transaction(async (client) => {
      const result = await client.query('select * from self_host_accounts where user_id=$1 for update', [userId]);
      const account = result.rows[0];
      if (!account) throw new SelfHostAuthError('account_not_found', 404);
      if (account.bootstrap_owner_key && input.enabled === false) throw new SelfHostAuthError('protected_account', 403);
      const status =
        input.enabled === undefined
          ? account.status
          : !input.enabled
            ? 'disabled'
            : account.password_digest
              ? 'active'
              : 'invited';
      await client.query('update self_host_accounts set display_name=$2,status=$3,updated_at=now() where user_id=$1', [
        userId,
        input.displayName ?? account.display_name,
        status,
      ]);
      if (input.displayName)
        await client.query('update users set display_name=$2,updated_at=now() where id=$1', [
          userId,
          input.displayName,
        ]);
      if (input.enabled === false) {
        await this.invalidate(client, userId);
        await client.query(
          'update self_host_account_tokens set revoked_at=now() where user_id=$1 and revoked_at is null',
          [userId],
        );
      }
      return { ok: true };
    });
  }
  async redeem(hash: string, purpose: string, salt: string, digest: string) {
    return this.transaction(async (client) => {
      const lookup = await client.query('select user_id from self_host_account_tokens where token_hash=$1', [hash]);
      if (!lookup.rows[0]) throw new SelfHostAuthError('invalid_token', 400);
      const userId = lookup.rows[0].user_id;
      const result = await client.query('select * from self_host_accounts where user_id=$1 for update', [userId]);
      const account = result.rows[0];
      if (!account || account.status === 'disabled' || (purpose === 'invite' && account.password_digest))
        throw new SelfHostAuthError('invalid_token', 400);
      const consumed = await client.query(
        `update self_host_account_tokens set consumed_at=now() where token_hash=$1 and purpose=$2 and consumed_at is null and revoked_at is null and expires_at>now() returning user_id`,
        [hash, purpose],
      );
      if (!consumed.rowCount) throw new SelfHostAuthError('invalid_token', 400);
      await client.query(
        `update self_host_accounts set password_scheme='scrypt-v1',password_salt=$2,password_digest=$3,status='active' where user_id=$1`,
        [userId, salt, digest],
      );
      await this.invalidate(client, userId);
      await client.query(
        'update self_host_account_tokens set revoked_at=now() where user_id=$1 and consumed_at is null',
        [userId],
      );
      return { username: String(account.username), displayName: String(account.display_name) };
    });
  }
  async replacePassword(userId: string, version: number, salt: string, digest: string) {
    await this.transaction(async (client) => {
      const locked = await client.query(
        `select user_id from self_host_accounts where user_id=$1 and auth_version=$2 and status='active' for update`,
        [userId, version],
      );
      if (!locked.rowCount) throw new SelfHostAuthError('invalid_credentials', 401);
      await client.query(
        `update self_host_accounts set password_scheme='scrypt-v1',password_salt=$2,password_digest=$3 where user_id=$1`,
        [userId, salt, digest],
      );
      await this.invalidate(client, userId);
      await client.query(
        'update self_host_account_tokens set revoked_at=now() where user_id=$1 and consumed_at is null',
        [userId],
      );
    });
  }

  async deleteExpiredSessions(now: string): Promise<void> {
    await this.pool.query(`delete from self_host_sessions where expires_at <= $1::timestamptz`, [now]);
  }
}
