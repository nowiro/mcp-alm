---
id: response.error
description: Canonical markdown view of a tool error (typed errors only)
version: 1.0.0
vars:
  - code
  - kind
  - message
  - tool
  - correlationId
  - retryable
  - hint
  - upstreamStatus
---

# Error: {{ kind }} ({{ code }})

**Tool:** `{{ tool }}` · **Correlation:** `{{ correlationId }}`{{#if retryable}} · **Retryable:** yes{{/if}}{{#if upstreamStatus}} · **Upstream:** HTTP {{ upstreamStatus }}{{/if}}

## Message

{{ message }}

{{#if hint}}

## Hint

{{ hint }}
{{/if}}
