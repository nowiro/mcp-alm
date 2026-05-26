---
id: response.sonar.get_issue
description: Canonical markdown view of a single SonarQube/SonarCloud issue
version: 1.0.0
vars:
  - key
  - project
  - component
  - rule
  - severity
  - type
  - status
  - resolution
  - effort
  - debt
  - line
  - message
  - tags
  - author
  - created
  - updated
  - assignee
  - codeSnippet
  - flows
---

# {{ key }} — {{ message }}

**Rule:** `{{ rule }}` · **Severity:** {{ severity | default:"?" }} · **Type:** {{ type | default:"?" }}

**Status:** {{ status | default:"?" }}{{#if resolution}} ({{ resolution }}){{/if}}

**Component:** `{{ component }}`{{#if line}} :{{ line }}{{/if}} · **Project:** `{{ project }}`

**Effort:** {{ effort | default:"—" }} · **Debt:** {{ debt | default:"—" }}

**Assignee:** {{ assignee | default:"—" }} · **Author:** {{ author | default:"—" }}

**Created:** {{ created | default:"?" }} · **Updated:** {{ updated | default:"?" }}

{{#if tags}}**Tags:** {{ tags }}{{/if}}

## Code snippet

{{ codeSnippet | default:"_not available — fetch with includeCodeSnippet=true_" }}

{{#if flows}}

## Data flows ({{ flows }})

{{#each flows}}

### Flow {{ this.index | default:"?" }}

{{#each this.locations}}

- `{{ this.component }}` :{{ this.line }} — {{ this.message }}
  {{/each}}
  {{/each}}
  {{/if}}
