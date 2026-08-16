BEGIN;

CREATE SCHEMA IF NOT EXISTS gmaps_scheduler;

CREATE TABLE IF NOT EXISTS gmaps_scheduler.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.workflows (
  workflow_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'FINALIZING', 'COMPLETE', 'FAILED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.boundaries (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  boundary_id text NOT NULL,
  boundary_name text NOT NULL,
  geometry jsonb NOT NULL,
  root_zoom integer NOT NULL CHECK (root_zoom BETWEEN 0 AND 22),
  weight numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, boundary_id)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.category_groups (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  category_group text NOT NULL,
  queries jsonb NOT NULL CHECK (jsonb_typeof(queries) = 'array'),
  estimated_requests integer NOT NULL DEFAULT 7 CHECK (estimated_requests > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, category_group)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.boundary_runtime (
  workflow_id text NOT NULL,
  boundary_id text NOT NULL,
  open_tasks bigint NOT NULL DEFAULT 0 CHECK (open_tasks >= 0),
  terminal_tasks bigint NOT NULL DEFAULT 0 CHECK (terminal_tasks >= 0),
  split_tasks bigint NOT NULL DEFAULT 0 CHECK (split_tasks >= 0),
  quarantined_tasks bigint NOT NULL DEFAULT 0 CHECK (quarantined_tasks >= 0),
  suspect_empty_tasks bigint NOT NULL DEFAULT 0 CHECK (suspect_empty_tasks >= 0),
  request_count bigint NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  reserved_requests numeric NOT NULL DEFAULT 0 CHECK (reserved_requests >= 0),
  last_claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, boundary_id),
  FOREIGN KEY (workflow_id, boundary_id)
    REFERENCES gmaps_scheduler.boundaries(workflow_id, boundary_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.tasks (
  workflow_id text NOT NULL,
  boundary_id text NOT NULL,
  category_group text NOT NULL,
  tile_id text NOT NULL,
  task_key text NOT NULL,
  parent_tile_id text,
  tile_zoom integer NOT NULL CHECK (tile_zoom BETWEEN 0 AND 22),
  tile_x integer NOT NULL CHECK (tile_x >= 0),
  tile_y integer NOT NULL CHECK (tile_y >= 0),
  bbox jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'CLAIMED', 'RETRY', 'DONE', 'DONE_EMPTY_CONFIRMED',
    'DONE_EMPTY_SUSPECT', 'SPLIT', 'QUARANTINED'
  )),
  priority integer NOT NULL DEFAULT 0,
  estimated_requests integer NOT NULL DEFAULT 7 CHECK (estimated_requests > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  result_place_count integer NOT NULL DEFAULT 0 CHECK (result_place_count >= 0),
  error_code text,
  error_message text,
  empty_diagnostics jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workflow_id, boundary_id, category_group, tile_id),
  UNIQUE (workflow_id, task_key),
  FOREIGN KEY (workflow_id, boundary_id)
    REFERENCES gmaps_scheduler.boundaries(workflow_id, boundary_id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id, category_group)
    REFERENCES gmaps_scheduler.category_groups(workflow_id, category_group) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON gmaps_scheduler.tasks (workflow_id, boundary_id, priority DESC, next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS tasks_lease_idx
  ON gmaps_scheduler.tasks (workflow_id, lease_expires_at)
  WHERE status = 'CLAIMED';

CREATE TABLE IF NOT EXISTS gmaps_scheduler.places (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  place_id text NOT NULL,
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, place_id)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.poi_observations (
  workflow_id text NOT NULL,
  boundary_id text NOT NULL,
  category_group text NOT NULL,
  tile_id text NOT NULL,
  place_id text NOT NULL,
  query_text text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, boundary_id, category_group, tile_id, place_id, query_text),
  FOREIGN KEY (workflow_id, boundary_id, category_group, tile_id)
    REFERENCES gmaps_scheduler.tasks(workflow_id, boundary_id, category_group, tile_id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_id, place_id)
    REFERENCES gmaps_scheduler.places(workflow_id, place_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS observations_boundary_place_idx
  ON gmaps_scheduler.poi_observations (workflow_id, boundary_id, place_id);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.worker_sessions (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  endpoint text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_probe_at timestamptz,
  last_probe_ok_at timestamptz,
  last_probe_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workflow_id, worker_id, endpoint)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.request_budgets (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('poi_search', 'reviews', 'images')),
  capacity numeric NOT NULL CHECK (capacity > 0),
  refill_per_second numeric NOT NULL CHECK (refill_per_second > 0),
  tokens numeric NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, endpoint)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.health_buckets (
  workflow_id text NOT NULL REFERENCES gmaps_scheduler.workflows(workflow_id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  bucket_start timestamptz NOT NULL,
  request_count bigint NOT NULL DEFAULT 0,
  success_count bigint NOT NULL DEFAULT 0,
  structurally_complete_count bigint NOT NULL DEFAULT 0,
  nonempty_count bigint NOT NULL DEFAULT 0,
  place_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, endpoint, bucket_start)
);

CREATE TABLE IF NOT EXISTS gmaps_scheduler.task_events (
  event_id bigserial PRIMARY KEY,
  workflow_id text NOT NULL,
  boundary_id text NOT NULL,
  category_group text NOT NULL,
  tile_id text NOT NULL,
  worker_id text,
  from_status text,
  to_status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx
  ON gmaps_scheduler.task_events (workflow_id, boundary_id, category_group, tile_id, created_at);

INSERT INTO gmaps_scheduler.schema_migrations(version)
VALUES ('001_adaptive_scheduler')
ON CONFLICT (version) DO NOTHING;

COMMIT;
