# GitLab pipeline patterns — quick reference

## Lifecycle

```
created → pending → running → (success | failed | canceled | skipped | manual)
```

`mcp-gitlab.list_pipelines` zwraca status + `duration` + `ref` + `sha` per pipeline.

## Common queries (przez `gitlab.list_pipelines`)

```ts
// Last 25 pipelines for main
gitlab.list_pipelines({ projectPath: 'myorg/api', ref: 'main', limit: 25 });

// Failed pipelines last week
gitlab.list_pipelines({ projectPath: 'myorg/api', status: 'failed', updated_after: '-7d' });

// Pipelines for a specific commit
gitlab.list_pipelines({ projectPath: 'myorg/api', sha: 'abc123' });
```

## Jobs + artifacts

Per-pipeline jobs (`gitlab.get_pipeline_jobs`) zwraca status + stage + duration + artefakty.

```ts
gitlab.get_pipeline_jobs({ projectPath: 'myorg/api', pipelineId: 12345 });
// → [{ id, name, stage, status, duration, artifacts_file: {...} }]
```

Pobranie pliku z artefaktów: `gitlab.get_artifacts({ projectPath, jobId, path })`.

## Job log + classification

```ts
gitlab.get_job_log({ projectPath: 'myorg/api', jobId: 67890, tail: 200 });
// → { log: string, total_lines: number }
```

**Klasyfikacja błędu** (manualnie po fetchu logu):

- **compile** — `error TS\d+`, `SyntaxError`, `cannot find module`
- **test** — `FAIL src/...`, `expected X received Y`, `Test suite failed`
- **timeout** — `Job exceeded the maximum allowed timeout`, hung > 60s without output
- **dependency** — `npm ERR! 404`, `ETIMEDOUT registry`, `unable to resolve dep`
- **infra** — `Cannot connect to runner`, `Image pull error`, `OOMKilled`

## Pipeline YAML — common patterns

```yaml
# Per-stage parallel jobs
test:
  parallel:
    matrix:
      - NODE: ['20', '22']
        OS: ['ubuntu-latest', 'macos-latest']

# Conditional run
deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: on_success
    - when: never

# Cache for npm
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths: [node_modules/, .npm/]

# Allow flaky job to retry
test:integration:
  retry:
    max: 2
    when:
      - runner_system_failure
      - script_failure
```

## Merge request workflow

```ts
// All my open MRs across org
gitlab.list_mrs({ scope: 'all', state: 'opened', author_username: '<you>' });

// MR changes (diff)
gitlab.merge_request_changes({ projectPath, mrIid: 123 });

// Merge if ready
gitlab.merge_mr({ projectPath, mrIid: 123, merge_commit_message: '...', squash: true });
```

`merge_mr` jest write tool — gated by `MCP_WRITE_ENABLED=true` + `MCP_WRITE_ALLOWLIST=gitlab.merge_mr`.

## Anti-patterns

- ❌ `list_pipelines` bez `ref` lub `updated_after` w long-lived project — 1000s of results.
- ❌ `get_job_log` z `tail: 0` (czyli pełen log) dla failing job z 50k linii — zjada budget.
- ❌ Skipping `pipeline_jobs` przed `get_job_log` — pipeline może mieć 20 jobs, zgaduj który failuje.
- ✅ Zawsze zawęź: `ref: "main"`, `updated_after: "-7d"`, `status: "failed"`.

## Rate limits

GitLab.com: 2 000 requests/min per user. Self-hosted: per Admin settings.

`mcp-gitlab` używa `http-client` z retry on 429 (jittered backoff) + parse `x-ratelimit-*` headers.
