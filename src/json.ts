import { z } from "zod";

export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = { [key: string]: JsonValue };

export async function readResponseBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  if (text.length === 0) return null;

  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return text;
  }
}
