import { nativeItemTimestampSql } from "../workers/telemetry-processor/frame-projector.ts";

// Batches can contain copied native items whose creation time differs from
// their envelope time. Use the same timestamp basis as the frame projector.
// SQL arguments are internal expressions, never user-supplied identifiers.
export function relevantBatchSql(
  start: string,
  end = "'infinity'::timestamptz",
): string {
  return `(
    (coalesce(batch.last_occurred_at, batch.committed_at) >= ${start}
     and coalesce(batch.first_occurred_at, batch.committed_at) < ${end})
    or (batch.committed_at >= ${start} and batch.committed_at < ${end})
    or exists (
      select 1 from telemetry.native_records record
      join telemetry.events event
        on event.workspace_id = record.workspace_id and event.source_record_id = record.id
       where record.workspace_id = batch.workspace_id and record.batch_id = batch.id
         and coalesce(${nativeItemTimestampSql("event.native_item_id")},
           event.occurred_at, event.observed_at, event.server_received_at) >= ${start}
         and coalesce(${nativeItemTimestampSql("event.native_item_id")},
           event.occurred_at, event.observed_at, event.server_received_at) < ${end}
    )
  )`;
}
