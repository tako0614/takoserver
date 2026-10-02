-- Accelerate public ContainerEndpoint hostname dispatch without a second route
-- ledger. The exact expression and partial predicate mirror the committed
-- Resource lookup in src/takoform/store.ts; duplicate hostnames remain visible
-- to LIMIT 2 and fail closed rather than becoming a uniqueness migration.
-- Guard JSON evaluation so a malformed historical resource document cannot
-- abort this additive index build.
CREATE INDEX tf_resources_container_endpoint_hostname
ON tf_resources (
  CASE WHEN json_valid(resource_json) = 1
    THEN json_extract(resource_json, '$.status.outputs.hostname')
    ELSE NULL END
)
WHERE api_version = 'edge.forms.takoform.com'
  AND kind = 'ContainerEndpoint';
