// Tiny hand-written validator for tool arguments (no schema library). Each field also describes itself as JSON Schema,
// so the schema the client sees and the rules that run cannot drift apart.
import { isValidChannel, isValidNick } from "../../vendor/irc-protocol/src/index.js";

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface Field<T, Opt extends boolean = false> {
  readonly optional: Opt;
  /** Overrides whether the JSON Schema lists the property as required (default: not optional). */
  readonly schemaRequired?: boolean;
  /** `name` is the property name used in error messages. */
  check(value: unknown, name: string): Result<T>;
  schema(): JsonSchema;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

/** Every C0 control (U+0000 to U+001F, which includes CR, LF, NUL, TAB and ESC) and DEL (U+007F). */
const CONTROL = /[\x00-\x1f\x7f]/;

/** A short, printable form of a rejected value for error messages (never the whole input). */
const preview = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const cut = text.length > 40 ? `${text.slice(0, 40)}...` : text;
  return JSON.stringify(cut).replace(/[\u0000-\u001f]/g, "?");
};

export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

/** A string of `min..max` characters (code points) with no C0 control character and no DEL. */
export function string(options: StringOptions = {}): Field<string> {
  const min = options.min ?? 0;
  return {
    optional: false,
    check(value, name) {
      if (typeof value !== "string") return fail(`${name}: must be a string`);
      if (CONTROL.test(value)) return fail(`${name}: must not contain control characters (C0 or DEL)`);
      const length = [...value].length;
      if (length < min) return fail(`${name}: must be at least ${min} character${min === 1 ? "" : "s"} long`);
      if (options.max !== undefined && length > options.max) return fail(`${name}: must be at most ${options.max} characters long`);
      return ok(value);
    },
    schema() {
      return {
        type: "string",
        ...(min > 0 ? { minLength: min } : {}),
        ...(options.max !== undefined ? { maxLength: options.max } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
      };
    },
  };
}

export interface IntOptions {
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

export function int(options: IntOptions = {}): Field<number> {
  return {
    optional: false,
    check(value, name) {
      if (typeof value !== "number" || !Number.isInteger(value)) return fail(`${name}: must be an integer`);
      if (options.min !== undefined && value < options.min) return fail(`${name}: must be at least ${options.min}`);
      if (options.max !== undefined && value > options.max) return fail(`${name}: must be at most ${options.max}`);
      return ok(value);
    },
    schema() {
      return {
        type: "integer",
        ...(options.min !== undefined ? { minimum: options.min } : {}),
        ...(options.max !== undefined ? { maximum: options.max } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
      };
    },
  };
}

/** Any boolean. A tool that needs `true` checks that itself (see `confirm`). */
export function bool(description?: string): Field<boolean> {
  return {
    optional: false,
    check(value, name) {
      return typeof value === "boolean" ? ok(value) : fail(`${name}: must be a boolean`);
    },
    schema() {
      return { type: "boolean", ...(description !== undefined ? { description } : {}) };
    },
  };
}

export function enumOf<const V extends readonly [string, ...string[]]>(values: V, description?: string): Field<V[number]> {
  return {
    optional: false,
    check(value, name) {
      if (typeof value === "string" && (values as readonly string[]).includes(value)) return ok(value as V[number]);
      return fail(`${name}: must be one of ${values.join(", ")}`);
    },
    schema() {
      return { type: "string", enum: [...values], ...(description !== undefined ? { description } : {}) };
    },
  };
}

/** A channel name that passes the vendored `isValidChannel`. */
export function channel(description = "Channel name, for example #fix-bug"): Field<string> {
  return {
    optional: false,
    check(value, name) {
      if (typeof value !== "string") return fail(`${name}: must be a string`);
      return isValidChannel(value) ? ok(value) : fail(`${name}: ${preview(value)} is not a valid channel name`);
    },
    schema() {
      return { type: "string", minLength: 2, maxLength: 200, pattern: "^#", description };
    },
  };
}

/** A nick that passes the vendored `isValidNick`. */
export function nick(description = "Nick of the agent or user"): Field<string> {
  return {
    optional: false,
    check(value, name) {
      if (typeof value !== "string") return fail(`${name}: must be a string`);
      return isValidNick(value) ? ok(value) : fail(`${name}: ${preview(value)} is not a valid nick`);
    },
    schema() {
      return { type: "string", minLength: 1, maxLength: 30, description };
    },
  };
}

/**
 * The `confirm` flag of dangerous tools. The schema tells the client it is a required boolean, but the validator lets
 * any value (or none) through so the tool itself can refuse with the "ask the human first" message. The tool must
 * act only on exactly `true`.
 */
export function confirmFlag(description: string, schemaRequired = true): Field<unknown, true> {
  return {
    optional: true,
    schemaRequired,
    check: (value) => ok(value),
    schema: () => ({ type: "boolean", description }),
  };
}

/** Make a field optional: absent (or undefined) is allowed; present values are checked. */
export function optional<T>(field: Field<T, false>): Field<T, true> {
  return {
    optional: true,
    check: (value, name) => field.check(value, name),
    schema: () => field.schema(),
  };
}

export type Shape = Readonly<Record<string, Field<unknown, boolean>>>;
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends Field<unknown, true> ? never : K }[keyof S];
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Field<unknown, true> ? K : never }[keyof S];
type ValueOf<F> = F extends Field<infer T, boolean> ? T : never;

export type Infer<S extends Shape> = { readonly [K in RequiredKeys<S>]: ValueOf<S[K]> } & { readonly [K in OptionalKeys<S>]?: ValueOf<S[K]> };

export interface ObjectSchema<S extends Shape> {
  /** Validate an arguments object. Rejects non-objects, unknown properties, missing required ones and bad values. */
  parse(input: unknown): Result<Infer<S>>;
  /** JSON Schema for tools/list, always with additionalProperties: false. */
  jsonSchema(): JsonSchema;
}

export function object<S extends Shape>(shape: S): ObjectSchema<S> {
  const keys = Object.keys(shape);
  return {
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("arguments: must be an object");
      const record = input as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(shape, key)) return fail(`arguments: unknown property ${preview(key)}`);
      }
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const field = shape[key];
        if (field === undefined) continue;
        const value = Object.hasOwn(record, key) ? record[key] : undefined;
        if (value === undefined) {
          if (!field.optional) return fail(`${key}: is required`);
          continue;
        }
        const checked = field.check(value, key);
        if (!checked.ok) return checked;
        out[key] = checked.value;
      }
      return ok(out as Infer<S>);
    },
    jsonSchema() {
      const required = keys.filter((k) => shape[k]?.schemaRequired ?? shape[k]?.optional === false);
      return {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, shape[k]?.schema() ?? {}])),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    },
  };
}
