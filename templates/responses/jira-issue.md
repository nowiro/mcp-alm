---
id: response.jira.get_issue
description: Canonical markdown view of a single Jira issue
version: 1.0.0
vars:
  - key
  - summary
  - status
  - issueType
  - priority
  - assignee
  - reporter
  - created
  - updated
  - parent
  - labels
  - components
  - description
  - links
  - comments
---

# {{ key }} — {{ summary }}

**Status:** {{ status | default:"—" }} · **Type:** {{ issueType | default:"—" }} · **Priority:** {{ priority | default:"—" }}

**Assignee:** {{ assignee | default:"—" }} · **Reporter:** {{ reporter | default:"—" }}

**Created:** {{ created | default:"?" }} · **Updated:** {{ updated | default:"?" }}

{{#if parent}}**Parent:** {{ parent.key }} — {{ parent.summary }}{{/if}}

{{#if labels}}**Labels:** {{ labels }}{{/if}}

{{#if components}}**Components:** {{ components }}{{/if}}

## Description

{{ description | default:"_empty_" }}

{{#if links}}

## Linked issues

{{#each links}}

- **{{ this.type }}** ({{ this.direction }}): `{{ this.key }}` — {{ this.summary }}
  {{/each}}
  {{/if}}

{{#if comments}}

## Comments ({{ comments }})

{{#each comments}}

### {{ this.author }} — {{ this.created }}

{{ this.body }}

{{/each}}
{{/if}}
