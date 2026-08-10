export function parseCliArgs(argv, { boolean = [], values = [] } = {}) {
  const booleanFlags = new Set(boolean);
  const valueFlags = new Set(values);
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (booleanFlags.has(rawName)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${rawName} does not accept a value`);
      }
      result[rawName] = true;
      continue;
    }
    if (!valueFlags.has(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${rawName} requires a value`);
    }
    result[rawName] = value;
  }
  return result;
}
