export default async function run(input) {
  if (input === null || input === undefined || typeof input !== "object") {
    return { error: "invalid input: expected an object" };
  }
  if (!input.input && !input.message) {
    return { error: "missing required field: input or message" };
  }
  return {
    echo: input.input ?? input.message,
    timestamp: new Date().toISOString(),
  };
}
