UPDATE core_knowledge_sources
SET access_scope_json = CASE
  WHEN NULLIF(json_extract(access_scope_json, '$.companyId'), '') IS NULL
    THEN json_set(access_scope_json, '$.tenantId', 'local')
  ELSE json_remove(
    json_set(
      json_set(
        access_scope_json,
        '$.tenantId',
        json_extract(access_scope_json, '$.companyId')
      ),
      '$.organizationId',
      COALESCE(
        NULLIF(json_extract(access_scope_json, '$.organizationId'), ''),
        json_extract(access_scope_json, '$.companyId')
      )
    ),
    '$.companyId'
  )
END
WHERE NULLIF(json_extract(access_scope_json, '$.tenantId'), '') IS NULL;

UPDATE core_memory_candidates
SET scope_json = CASE
  WHEN NULLIF(json_extract(scope_json, '$.companyId'), '') IS NULL
    THEN json_set(scope_json, '$.tenantId', 'local')
  ELSE json_remove(
    json_set(
      json_set(
        scope_json,
        '$.tenantId',
        json_extract(scope_json, '$.companyId')
      ),
      '$.organizationId',
      COALESCE(
        NULLIF(json_extract(scope_json, '$.organizationId'), ''),
        json_extract(scope_json, '$.companyId')
      )
    ),
    '$.companyId'
  )
END
WHERE NULLIF(json_extract(scope_json, '$.tenantId'), '') IS NULL;

CREATE INDEX IF NOT EXISTS idx_core_knowledge_sources_tenant_org
  ON core_knowledge_sources(
    json_extract(access_scope_json, '$.tenantId'),
    json_extract(access_scope_json, '$.organizationId')
  );

CREATE INDEX IF NOT EXISTS idx_core_memory_candidates_tenant_org
  ON core_memory_candidates(
    json_extract(scope_json, '$.tenantId'),
    json_extract(scope_json, '$.organizationId'),
    decision,
    created_at
  );
