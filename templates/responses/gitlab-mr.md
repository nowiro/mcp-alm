---
id: response.gitlab.get_mr
description: Canonical markdown view of a single GitLab merge request
version: 1.0.0
vars:
  - iid
  - projectPath
  - title
  - state
  - draft
  - author
  - assignees
  - reviewers
  - sourceBranch
  - targetBranch
  - mergeStatus
  - pipelineStatus
  - created
  - updated
  - labels
  - description
  - discussions
  - changes
---

# !{{ iid }} — {{ title }}

**Repo:** `{{ projectPath }}` · **State:** {{ state | default:"?" }}{{#if draft}} · **Draft**{{/if}}

**Branches:** `{{ sourceBranch }}` → `{{ targetBranch }}`

**Merge status:** {{ mergeStatus | default:"?" }} · **Pipeline:** {{ pipelineStatus | default:"—" }}

**Author:** {{ author | default:"—" }} · **Assignees:** {{ assignees | default:"—" }} · **Reviewers:** {{ reviewers | default:"—" }}

**Created:** {{ created | default:"?" }} · **Updated:** {{ updated | default:"?" }}

{{#if labels}}**Labels:** {{ labels }}{{/if}}

## Description

{{ description | default:"_empty_" }}

{{#if changes}}

## Changed files ({{ changes }})

{{#each changes}}

- `{{ this.path }}` — +{{ this.additions | default:"0" }} / -{{ this.deletions | default:"0" }}{{#if this.renamed}} (renamed){{/if}}
  {{/each}}
  {{/if}}

{{#if discussions}}

## Discussions ({{ discussions }})

{{#each discussions}}

### {{ this.author }} — {{ this.created }}

{{ this.body }}

{{/each}}
{{/if}}
