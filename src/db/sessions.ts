import type { PendingApproval, PendingQuestion, Session } from '../types.js';
import { get, all, run, hasTable } from './connection.js';

// ── Sessions ──

export async function createSession(session: Session): Promise<void> {
  await run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      session.id,
      session.agent_group_id,
      session.messaging_group_id,
      session.thread_id,
      session.agent_provider,
      session.status,
      session.container_status,
      session.last_active,
      session.created_at,
    ],
  );
}

export async function getSession(id: string): Promise<Session | undefined> {
  return get<Session>('SELECT * FROM sessions WHERE id = $1', [id]);
}

export async function findSession(messagingGroupId: string, threadId: string | null): Promise<Session | undefined> {
  if (threadId) {
    return get<Session>('SELECT * FROM sessions WHERE messaging_group_id = $1 AND thread_id = $2 AND status = $3', [
      messagingGroupId,
      threadId,
      'active',
    ]);
  }
  return get<Session>('SELECT * FROM sessions WHERE messaging_group_id = $1 AND thread_id IS NULL AND status = $2', [
    messagingGroupId,
    'active',
  ]);
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out).
 */
export async function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Promise<Session | undefined> {
  if (threadId) {
    return get<Session>(
      `SELECT * FROM sessions WHERE agent_group_id = $1 AND messaging_group_id = $2 AND thread_id = $3 AND status = 'active'`,
      [agentGroupId, messagingGroupId, threadId],
    );
  }
  return get<Session>(
    `SELECT * FROM sessions WHERE agent_group_id = $1 AND messaging_group_id = $2 AND thread_id IS NULL AND status = 'active'`,
    [agentGroupId, messagingGroupId],
  );
}

/** Find an active session scoped to an agent group (ignoring messaging group). */
export async function findSessionByAgentGroup(agentGroupId: string): Promise<Session | undefined> {
  return get<Session>(
    `SELECT * FROM sessions WHERE agent_group_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [agentGroupId],
  );
}

export async function getSessionsByAgentGroup(agentGroupId: string): Promise<Session[]> {
  return all<Session>('SELECT * FROM sessions WHERE agent_group_id = $1', [agentGroupId]);
}

export async function getActiveSessions(): Promise<Session[]> {
  return all<Session>(`SELECT * FROM sessions WHERE status = 'active'`);
}

export async function getRunningSessions(): Promise<Session[]> {
  return all<Session>(`SELECT * FROM sessions WHERE container_status IN ('running', 'idle')`);
}

// Runtime allowlist mirroring the compile-time Pick<Session, …> bound on updateSession.
// TypeScript's Partial<Pick<...>> is erased at runtime; without this Set, any caller
// routing untrusted input through updateSession would splice arbitrary keys directly
// into the UPDATE column list (SQL injection).
const ALLOWED_SESSION_COLUMNS = new Set<string>(['status', 'container_status', 'last_active', 'agent_provider']);

export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_SESSION_COLUMNS.has(key)) {
      throw new Error(`updateSession: rejected column "${key}" (not in allowlist)`);
    }
    if (value !== undefined) {
      fields.push(`${key} = $${values.length + 1}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;

  values.push(id);
  await run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
}

export async function deleteSession(id: string): Promise<void> {
  await run('DELETE FROM sessions WHERE id = $1', [id]);
}

// ── Pending Questions ──

/**
 * Insert a pending question row. Idempotent: when delivery fails and retries,
 * the second attempt calls this with the same question_id — without ON CONFLICT
 * DO NOTHING that would throw UNIQUE and prevent the retry from reaching the
 * actual send step. Returns true if a new row was inserted.
 *
 * (SQLite variant used idempotent-insert — translated to INSERT … ON CONFLICT DO NOTHING
 * for PgBouncer-safe Postgres.)
 */
export async function createPendingQuestion(pq: PendingQuestion): Promise<boolean> {
  const rows = await run(
    `INSERT INTO pending_questions (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (question_id) DO NOTHING`,
    [
      pq.question_id,
      pq.session_id,
      pq.message_out_id,
      pq.platform_id,
      pq.channel_type,
      pq.thread_id,
      pq.title,
      JSON.stringify(pq.options),
      pq.created_at,
    ],
  );
  return rows > 0;
}

export async function getPendingQuestion(questionId: string): Promise<PendingQuestion | undefined> {
  const row = await get<Omit<PendingQuestion, 'options'> & { options_json: string }>(
    'SELECT * FROM pending_questions WHERE question_id = $1',
    [questionId],
  );
  if (!row) return undefined;
  const { options_json, ...rest } = row;
  return { ...rest, options: JSON.parse(options_json) };
}

export async function deletePendingQuestion(questionId: string): Promise<void> {
  await run('DELETE FROM pending_questions WHERE question_id = $1', [questionId]);
}

// ── Pending Approvals ──

/**
 * Insert a pending approval row. Idempotent for the same reason as
 * createPendingQuestion: delivery retries with the same approval_id must not
 * fail on UNIQUE before the send step gets a chance to succeed.
 *
 * (SQLite variant used idempotent-insert — translated to INSERT … ON CONFLICT DO NOTHING.)
 */
export async function createPendingApproval(
  pa: Partial<PendingApproval> &
    Pick<
      PendingApproval,
      'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
    >,
): Promise<boolean> {
  const merged = {
    session_id: null,
    agent_group_id: null,
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    ...pa,
  };

  const rows = await run(
    `INSERT INTO pending_approvals
       (approval_id, session_id, request_id, action, payload, created_at,
        agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status,
        title, options_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (approval_id) DO NOTHING`,
    [
      merged.approval_id,
      merged.session_id,
      merged.request_id,
      merged.action,
      merged.payload,
      merged.created_at,
      merged.agent_group_id,
      merged.channel_type,
      merged.platform_id,
      merged.platform_message_id,
      merged.expires_at,
      merged.status,
      merged.title,
      merged.options_json,
    ],
  );
  return rows > 0;
}

export async function getPendingApproval(approvalId: string): Promise<PendingApproval | undefined> {
  return get<PendingApproval>('SELECT * FROM pending_approvals WHERE approval_id = $1', [approvalId]);
}

export async function updatePendingApprovalStatus(
  approvalId: string,
  status: PendingApproval['status'],
): Promise<void> {
  await run('UPDATE pending_approvals SET status = $1 WHERE approval_id = $2', [status, approvalId]);
}

export async function deletePendingApproval(approvalId: string): Promise<void> {
  await run('DELETE FROM pending_approvals WHERE approval_id = $1', [approvalId]);
}

export async function getPendingApprovalsByAction(action: string): Promise<PendingApproval[]> {
  return all<PendingApproval>('SELECT * FROM pending_approvals WHERE action = $1', [action]);
}

/**
 * Resolve ask_question render metadata (title + normalized options) for any
 * card, regardless of whether it was persisted as a pending_question or
 * a pending_approval.
 */
export async function getAskQuestionRender(
  id: string,
): Promise<{ title: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined> {
  const q = await getPendingQuestion(id);
  if (q) return { title: q.title, options: q.options };

  const a = await get<{ title: string; options_json: string }>(
    'SELECT title, options_json FROM pending_approvals WHERE approval_id = $1',
    [id],
  );
  if (a?.title) return { title: a.title, options: JSON.parse(a.options_json) };

  // Channel-registration + unknown-sender approvals persist title/options_json
  // the same way pending_approvals does — just SELECT and return.
  if (await hasTable('pending_channel_approvals')) {
    const c = await get<{ title: string; options_json: string }>(
      'SELECT title, options_json FROM pending_channel_approvals WHERE messaging_group_id = $1',
      [id],
    );
    if (c?.title) return { title: c.title, options: JSON.parse(c.options_json) };
  }

  if (await hasTable('pending_sender_approvals')) {
    const s = await get<{ title: string; options_json: string }>(
      'SELECT title, options_json FROM pending_sender_approvals WHERE id = $1',
      [id],
    );
    if (s?.title) return { title: s.title, options: JSON.parse(s.options_json) };
  }

  return undefined;
}
