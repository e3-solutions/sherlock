alter table telemetry.native_records
  add column native_record_start_offset bigint,
  add column native_record_end_offset bigint,
  add column native_record_sha256 text,
  add column fragment_index integer,
  add column fragment_count integer;

alter table telemetry.native_records
  drop constraint native_records_parse_status_check,
  add constraint native_records_parse_status_check check (
    parse_status in ('ok', 'unknown', 'malformed', 'fragment')
  ),
  add constraint native_records_fragment_metadata_check check (
    (
      parse_status = 'fragment' and
      native_record_start_offset is not null and
      native_record_end_offset is not null and
      native_record_sha256 is not null and
      fragment_index is not null and
      fragment_count is not null and
      native_record_start_offset <= source_start_offset and
      source_end_offset <= native_record_end_offset and
      native_record_end_offset > native_record_start_offset and
      native_record_sha256 ~ '^[0-9a-f]{64}$' and
      fragment_index >= 0 and
      fragment_count >= 2 and
      fragment_index < fragment_count and
      (fragment_index = 0) =
        (source_start_offset = native_record_start_offset) and
      (fragment_index = fragment_count - 1) =
        (source_end_offset = native_record_end_offset)
    ) or (
      parse_status <> 'fragment' and
      native_record_start_offset is null and
      native_record_end_offset is null and
      native_record_sha256 is null and
      fragment_index is null and
      fragment_count is null
    )
  );
