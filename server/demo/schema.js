import Ajv2020 from 'ajv/dist/2020.js';

// Must stay in sync with server/fields.js. The tool contract requires exactly these keys.
export const FIELD_KEYS = Object.freeze([
  'permitNumber',
  'plateNumber',
  'issuingRegion',
  'validFrom',
  'validTo',
  'length',
  'width',
  'height',
  'weight',
  'axleCount',
  'passRoute',
]);

// Nullable is expressed as anyOf so Ajv never coerces null into a string or number.
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableConfidence = {
  anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }],
};

const toolFieldSchema = {
  type: 'object',
  properties: {
    raw: nullableString,
    confidence: nullableConfidence,
    evidenceQuote: nullableString,
  },
  required: ['raw', 'confidence', 'evidenceQuote'],
  additionalProperties: false,
};

export const TOOL_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(FIELD_KEYS.map((key) => [key, toolFieldSchema])),
  required: [...FIELD_KEYS],
  additionalProperties: false,
};

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const textCandidate = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

const dateCandidate = {
  type: 'object',
  properties: { value: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' } },
  required: ['value'],
  additionalProperties: false,
};

const measurementCandidate = (unit) => ({
  type: 'object',
  properties: {
    value: { type: 'number' },
    unit: { enum: [unit] },
  },
  required: ['value', 'unit'],
  additionalProperties: false,
});

const axleCandidate = {
  type: 'object',
  properties: { value: { type: 'integer' } },
  required: ['value'],
  additionalProperties: false,
};

const candidateSchemas = {
  permitNumber: textCandidate,
  plateNumber: textCandidate,
  issuingRegion: textCandidate,
  validFrom: dateCandidate,
  validTo: dateCandidate,
  length: measurementCandidate('m'),
  width: measurementCandidate('m'),
  height: measurementCandidate('m'),
  weight: measurementCandidate('kg'),
  axleCount: axleCandidate,
  passRoute: textCandidate,
};

// Null records a missing/unknown/normalization-failed value; business rules later require all eleven.
export const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    FIELD_KEYS.map((key) => [key, nullable(candidateSchemas[key])]),
  ),
  required: [...FIELD_KEYS],
  additionalProperties: false,
};

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  validateFormats: false,
});

const validateTool = ajv.compile(TOOL_SCHEMA);

function errorPath(error) {
  if (error.keyword === 'required' && error.params?.missingProperty) {
    return `${error.instancePath}/${error.params.missingProperty}`;
  }
  if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
    return `${error.instancePath}/${error.params.additionalProperty}`;
  }
  return error.instancePath;
}

export function validateToolArguments(value) {
  if (validateTool(value)) return { ok: true, errors: [] };
  const errors = (validateTool.errors ?? []).map((error) => ({
    path: errorPath(error),
    code: error.keyword,
    message: error.message || '参数不符合工具 Schema。',
  }));
  return { ok: false, errors };
}
