CREATE TABLE consensus_view_observations (
    source_id integer NOT NULL,
    response_id bigint NOT NULL,
    response_index integer NOT NULL CHECK (response_index >= 0),
    view_id numeric(20, 0) NOT NULL CHECK (view_id BETWEEN 0 AND 18446744073709551615),
    view_timestamp_secs numeric(20, 0) NOT NULL CHECK (view_timestamp_secs >= 0),
    certificate_status text NOT NULL CHECK (certificate_status IN ('tentative', 'full', 'none')),
    epoch numeric(20, 0) NOT NULL CHECK (epoch >= 0),
    committee_round numeric(20, 0) NOT NULL CHECK (committee_round >= 0),
    block_hash text CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    normalized_record jsonb NOT NULL,
    normalizer_version integer NOT NULL CHECK (normalizer_version > 0),
    materialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (response_id, response_index),
    UNIQUE (source_id, view_id, response_id, response_index),
    FOREIGN KEY (source_id, response_id) REFERENCES rpc_responses (source_id, id)
);

CREATE TABLE observation_index_results (
    source_id integer NOT NULL,
    response_id bigint PRIMARY KEY,
    normalizer_version integer NOT NULL CHECK (normalizer_version > 0),
    outcome text NOT NULL,
    occurrence_count integer,
    error_message text,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (outcome = 'indexed' AND occurrence_count IS NOT NULL AND occurrence_count >= 0 AND error_message IS NULL)
        OR (outcome = 'unsupported' AND occurrence_count IS NULL AND error_message IS NOT NULL)
    ),
    FOREIGN KEY (source_id, response_id) REFERENCES rpc_responses (source_id, id)
);
CREATE INDEX unsupported_observations_by_source
    ON observation_index_results (source_id) WHERE outcome = 'unsupported';

CREATE INDEX view_responses_by_source
    ON rpc_responses (source_id, id) WHERE method = 'phase_getViewRecords';

ALTER TABLE consensus_views
    ADD COLUMN current_response_index integer,
    ADD FOREIGN KEY (source_id, view_id, current_response_id, current_response_index)
        REFERENCES consensus_view_observations (source_id, view_id, response_id, response_index);
