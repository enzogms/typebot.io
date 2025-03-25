// Do not edit this file manually
import type { ForgedBlock } from "./schemas";

export const forgedBlockIds = [
  "openai",
  "cal-com",
  "chat-node",
  "qr-code",
  "dify-ai",
  "mistral",
  "elevenlabs",
  "anthropic",
  "together-ai",
  "open-router",
  "nocodb",
  "segment",
  "posthog",
  "groq",
  "zendesk",
  "perplexity",
  "deepseek",
  "blink",
] as const satisfies readonly ForgedBlock["type"][];
