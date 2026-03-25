import { BenchConfig } from "./types.js";

/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1]; practically [0, 1] for embeddings.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Fetch embedding from Ollama.
 * Throws if Ollama is not running or model is unavailable.
 */
export async function embed(text: string, config: BenchConfig): Promise<number[]> {
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const body = JSON.stringify({ model: config.embedModel, prompt: text });
  let res: Response;
  try {
    res = await fetch(`${ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${ollamaHost}. ` +
      `Start Ollama and ensure model '${config.embedModel}' is pulled.`
    );
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Ollama error (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) {
    throw new Error(`Ollama returned an unexpected response (no embedding array).`);
  }
  return json.embedding;
}

/**
 * Compute pairwise cosine similarities across a set of outputs,
 * returning min and avg.
 */
export async function consistencyStats(
  outputs: string[],
  config: BenchConfig
): Promise<{ minSimilarity: number; avgSimilarity: number }> {
  const vectors = await Promise.all(outputs.map((o) => embed(o, config)));
  const pairs: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      pairs.push(cosineSimilarity(vectors[i], vectors[j]));
    }
  }
  if (pairs.length === 0) return { minSimilarity: 1, avgSimilarity: 1 };
  const min = Math.min(...pairs);
  const avg = pairs.reduce((a, b) => a + b, 0) / pairs.length;
  return { minSimilarity: min, avgSimilarity: avg };
}
