// =============================================================================
// FULCRUM FORGE — Sync Utils: shared sync status helpers across all entities
// =============================================================================

const SYNC_STATUS_CREATE_PENDING = 'create-pending';
const SYNC_STATUS_UPDATE_PENDING = 'update-pending';
const SYNC_STATUS_IN_SYNC        = 'in-sync';
const SYNC_STATUS_CREATE_FAILED  = 'create-failed';
const SYNC_STATUS_UPDATE_FAILED  = 'update-failed';

// Computes the sync_status for an entity being updated.
// create-pending and create-failed both reset to create-pending — the sync job must
// still CREATE the record in the target; setting update-pending would issue an UPDATE
// on a non-existent row.  All other states (update-pending, update-failed, in-sync)
// become update-pending.  sync_notes must be cleared by the caller.
function computeSyncStatus(currentStatus) {
  const createStates = new Set([SYNC_STATUS_CREATE_PENDING, SYNC_STATUS_CREATE_FAILED]);
  return createStates.has(currentStatus)
    ? SYNC_STATUS_CREATE_PENDING
    : SYNC_STATUS_UPDATE_PENDING;
}
