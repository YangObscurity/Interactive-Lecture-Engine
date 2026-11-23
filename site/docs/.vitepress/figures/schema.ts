/**
 * JSON Schema (Draft-07) for `<figuresDir>/<group>/figures.json`.
 * Strict `additionalProperties: false` everywhere so unknown fields are rejected by Ajv.
 */

export const FIGURE_ID_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'
export const GROUP_NAME_PATTERN = '^[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*$'
export const SHA256_12_PATTERN = '^[0-9a-f]{12}$'

export const FIGURES_REGISTRY_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'FiguresRegistry',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'group', 'figures'],
  properties: {
    version: { const: 1 },
    group: {
      type: 'string',
      minLength: 1,
      pattern: GROUP_NAME_PATTERN,
    },
    figures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'kind', 'width', 'height', 'caption', 'source', 'sha256'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            pattern: FIGURE_ID_PATTERN,
          },
          file: {
            type: 'string',
            minLength: 1,
          },
          kind: {
            type: 'string',
            enum: ['figure', 'table'],
          },
          width: {
            type: 'integer',
            minimum: 1,
          },
          height: {
            type: 'integer',
            minimum: 1,
          },
          caption: {
            type: 'object',
            additionalProperties: false,
            required: ['zh', 'en'],
            properties: {
              zh: { type: 'string', minLength: 1 },
              en: { type: 'string', minLength: 1 },
            },
          },
          source: {
            type: 'object',
            additionalProperties: false,
            required: ['paper'],
            properties: {
              paper: { type: 'string', minLength: 1 },
              number: { type: 'string', minLength: 1 },
              page: {
                anyOf: [
                  { type: 'integer', minimum: 1 },
                  { type: 'string', minLength: 1 },
                ],
              },
            },
          },
          doi: {
            type: 'string',
            minLength: 1,
          },
          url: {
            type: 'string',
            minLength: 1,
          },
          sha256: {
            type: 'string',
            pattern: SHA256_12_PATTERN,
          },
          original: {
            type: 'string',
            minLength: 1,
          },
        },
      },
    },
  },
} as const
