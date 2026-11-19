-- Removes credentials that upstream error bodies echoed back into stored records.
--
-- From this version on, ingestion blanks out anything written like a credential
-- in `raw.fail.body` (see redactCredentials in ingest.ts). This applies the
-- same patterns to the rows that are already there. It only rewrites rows that
-- match, changes nothing else in them, and is harmless to run on an empty table.

update events
set raw = jsonb_set(
  raw,
  '{fail,body}',
  to_jsonb(
    regexp_replace(
      regexp_replace(
        raw #>> '{fail,body}',
        '\m(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{16,}',
        '\1\2[redacted]',
        'gi'
      ),
      '((?:authorization|x-api-key|x-goog-api-key|api[-_]key)["'']?\s*[:=]\s*["'']?)(?!bearer\M|basic\M)[^\s"'',;]{16,}',
      '\1[redacted]',
      'gi'
    )
  )
)
where failed
  and jsonb_typeof(raw #> '{fail,body}') = 'string'
  and raw #>> '{fail,body}' ~* '(\m(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,})|((authorization|x-api-key|x-goog-api-key|api[-_]key)["'']?\s*[:=]\s*["'']?[^\s"'',;]{16,})';
