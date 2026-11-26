CREATE TABLE IF NOT EXISTS sources (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    endpoint text NOT NULL,
    chain_id numeric(20, 0) NOT NULL CHECK (chain_id >= 0),
    genesis_hash text NOT NULL CHECK (genesis_hash ~ '^0x[0-9a-f]{64}$'),
    UNIQUE (endpoint, chain_id, genesis_hash)
);

CREATE TABLE IF NOT EXISTS rpc_responses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES sources (id),
    method text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN (
        'chain_identity', 'view_page', 'retention_probe', 'latest_head', 'finalized_head', 'superseded_poll'
    )),
    request_body text NOT NULL,
    response_body bytea NOT NULL,
    observed_at timestamptz NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (source_id, id)
);

CREATE TABLE IF NOT EXISTS collector_checkpoints (
    source_id integer PRIMARY KEY REFERENCES sources (id),
    revision bigint NOT NULL DEFAULT 0,
    high_view_id numeric(20, 0) CHECK (high_view_id >= 0),
    last_success_at timestamptz,
    last_retention_probe_at timestamptz,
    retention_floor_view_id numeric(20, 0) CHECK (retention_floor_view_id >= 0),
    retention_floor_response_id bigint,
    FOREIGN KEY (source_id, retention_floor_response_id) REFERENCES rpc_responses (source_id, id)
);

CREATE TABLE IF NOT EXISTS consensus_views (
    source_id integer NOT NULL REFERENCES sources (id),
    view_id numeric(20, 0) NOT NULL CHECK (view_id >= 0),
    view_timestamp_secs numeric(20, 0) NOT NULL CHECK (view_timestamp_secs >= 0),
    block_height numeric(20, 0) CHECK (block_height >= 0),
    certificate_status text NOT NULL CHECK (certificate_status IN ('tentative', 'full', 'none')),
    normalized_record jsonb NOT NULL,
    first_response_id bigint NOT NULL,
    current_response_id bigint NOT NULL,
    first_observed_at timestamptz NOT NULL,
    last_observed_at timestamptz NOT NULL,
    last_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (source_id, view_id),
    FOREIGN KEY (source_id, first_response_id) REFERENCES rpc_responses (source_id, id),
    FOREIGN KEY (source_id, current_response_id) REFERENCES rpc_responses (source_id, id)
);

CREATE TABLE IF NOT EXISTS view_gaps (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES sources (id),
    first_view_id numeric(20, 0) NOT NULL CHECK (first_view_id >= 0),
    last_view_id numeric(20, 0) NOT NULL CHECK (last_view_id >= first_view_id),
    state text NOT NULL CHECK (state IN ('candidate_sequence_gap', 'unrecoverable_from_source')),
    detected_at timestamptz NOT NULL,
    evidence_response_id bigint NOT NULL,
    superseded_at timestamptz,
    supersedes_gap_id bigint REFERENCES view_gaps (id),
    FOREIGN KEY (source_id, evidence_response_id) REFERENCES rpc_responses (source_id, id)
);
CREATE INDEX IF NOT EXISTS active_view_gaps_by_source
    ON view_gaps (source_id, first_view_id, last_view_id)
    WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS collector_observation_gaps (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id integer NOT NULL REFERENCES sources (id),
    after_success_at timestamptz NOT NULL,
    resumed_at timestamptz NOT NULL CHECK (resumed_at > after_success_at),
    evidence_response_id bigint NOT NULL,
    FOREIGN KEY (source_id, evidence_response_id) REFERENCES rpc_responses (source_id, id)
);
CREATE INDEX IF NOT EXISTS observation_gaps_by_source
    ON collector_observation_gaps (source_id, resumed_at DESC);

CREATE TABLE IF NOT EXISTS block_head_observations (
    response_id bigint PRIMARY KEY,
    source_id integer NOT NULL REFERENCES sources (id),
    tag text NOT NULL CHECK (tag IN ('latest', 'finalized')),
    height numeric(20, 0) NOT NULL CHECK (height >= 0),
    hash text NOT NULL CHECK (hash ~ '^0x[0-9a-f]{64}$'),
    block_timestamp_secs numeric(20, 0) NOT NULL CHECK (block_timestamp_secs >= 0),
    FOREIGN KEY (source_id, response_id) REFERENCES rpc_responses (source_id, id)
);
CREATE INDEX IF NOT EXISTS heads_by_source_tag
    ON block_head_observations (source_id, tag, response_id DESC);
