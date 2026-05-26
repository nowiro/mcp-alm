---
id: response.confluence.get_page
description: Canonical markdown view of a single Confluence page
version: 1.0.0
vars:
  - id
  - title
  - space
  - version
  - updated
  - updatedBy
  - ancestors
  - body
  - children
  - attachments
---

# {{ title }}

**Space:** {{ space.key | default:"?" }}{{#if space.name}} ({{ space.name }}){{/if}} · **Version:** {{ version | default:"?" }}

**Updated:** {{ updated | default:"?" }} by {{ updatedBy | default:"—" }}

{{#if ancestors}}
**Ancestors:** {{#each ancestors}}`{{ this.id }}` — {{ this.title }} / {{/each}}
{{/if}}

## Body

{{ body | default:"_empty_" }}

{{#if children}}

## Children ({{ children }})

{{#each children}}

- `{{ this.id }}` — {{ this.title }}
  {{/each}}
  {{/if}}

{{#if attachments}}

## Attachments ({{ attachments }})

| title | type | size |
| ----- | ---- | ---- |

{{#each attachments}}
| {{ this.title }} | {{ this.mediaType }} | {{ this.size }} |
{{/each}}
{{/if}}
