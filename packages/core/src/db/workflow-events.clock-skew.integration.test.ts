// @archon-test-isolated
/**
 * Integration test: workflow history order against a REAL bun:sqlite database when
 * the wall clock steps backward.
 *
 * A host resuming from sleep (WSL2 after Windows hibernate, a VM after an NTP
 * correction) can step the clock back mid-run. `created_at` then sorts a node_completed
 * row BEFORE the node_started row inserted earlier, and a resume snapshot ordered by
 * time folds the node as started-but-unfinished: its output vanishes and a resumed
 * loop_group's until_bash cannot resolve `$node.output`. `event_order` is allocated on
 * insert, so history must follow it ahead of the timestamp.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated): it
 * mock.module's ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { expect, mock, test } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { getDagResumeSnapshot, listWorkflowEvents } = await import('./workflow-events');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'cli', 'conv-1-platform')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message)
   VALUES ('run-1', 'conv-1', 'wf', '')`,
  []
);

async function insertEvent(
  eventType: string,
  stepName: string,
  createdAt: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
     VALUES ('run-1', $1, $2, $3, $4)`,
    [eventType, stepName, JSON.stringify(data), createdAt]
  );
}

// Inserted in lifecycle order; the clock stepped back ~12 s between the two rows.
await insertEvent('node_started', 'group.probe', '2026-11-05 12:05:36');
await insertEvent('node_completed', 'group.probe', '2026-11-05 12:05:24', {
  node_output: '{"state":"pending"}',
});

test('a resume snapshot keeps a completion recorded after the clock stepped back', async () => {
  const snapshot = await getDagResumeSnapshot('run-1');
  expect(snapshot.completedNodeOutputs.get('group.probe')?.output).toBe('{"state":"pending"}');
});

test('a run history lists events in insertion order, not timestamp order', async () => {
  const events = await listWorkflowEvents('run-1');
  expect(events.map(e => e.event_type)).toEqual(['node_started', 'node_completed']);
});
