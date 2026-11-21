// Account deletion after the 14-day grace period. Pure logic, injected client, so it
// runs under `deno test` without a database.

export interface PurgeClient {
  dueAccounts(): Promise<string[]>;
  /** Hands over or deletes the user's feeds and wipes their personal data (SQL, idempotent). */
  purgeData(userId: string): Promise<{ feeds_transferred: number; feeds_deleted: number }>;
  /** Deletes the auth user; resolves `false` when the user was already gone. */
  deleteAuthUser(userId: string): Promise<boolean>;
}

export interface PurgeResult {
  due: number;
  deleted: number;
  failed: number;
  feeds_transferred: number;
  feeds_deleted: number;
}

export async function runPurge(client: PurgeClient, max = 50): Promise<PurgeResult> {
  const due = (await client.dueAccounts()).slice(0, max);
  const result: PurgeResult = { due: due.length, deleted: 0, failed: 0, feeds_transferred: 0, feeds_deleted: 0 };
  for (const userId of due) {
    try {
      const r = await client.purgeData(userId);
      result.feeds_transferred += r.feeds_transferred;
      result.feeds_deleted += r.feeds_deleted;
      await client.deleteAuthUser(userId);
      result.deleted += 1;
    } catch {
      // One failure doesn't stop the others; the account stays due and is retried next run.
      result.failed += 1;
    }
  }
  return result;
}

/** Constant-time comparison of the bearer token with the service-role key. */
export function isServiceRole(authorization: string | null, serviceKey: string | undefined): boolean {
  if (!serviceKey || !authorization?.startsWith("Bearer ")) return false;
  const given = authorization.slice("Bearer ".length);
  if (given.length !== serviceKey.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  return diff === 0;
}
