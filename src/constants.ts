// Default models per provider
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  ollama: 'llama3.2',
};

// Groq uses OpenAI-compatible API
export const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1';
export const OLLAMA_API_BASE_URL = 'http://localhost:11434/v1';

// Stuck detection
export const DEFAULT_STUCK_WINDOW_SIZE = 8;
export const DEFAULT_STUCK_THRESHOLD = 3;

// Vision-capable providers
export const VISION_PROVIDERS = new Set(['anthropic', 'openai', 'gemini']);

// Providers that support extended thinking/reasoning
export const THINKING_PROVIDERS = new Set(['anthropic', 'gemini', 'openai']);

// Model pricing: [inputCostPerMillionTokens, outputCostPerMillionTokens] in USD
export const MODEL_PRICING: Record<string, [number, number]> = {
  // Gemini
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-2.5-flash-preview-05-20': [0.15, 0.6],
  'gemini-1.5-flash': [0.075, 0.3],
  'gemini-1.5-pro': [1.25, 5.0],
  'gemini-2.5-pro-preview-05-06': [1.25, 10.0],
  'gemini-3-flash-preview': [0.5, 3.0],
  'gemini-3-pro-image-preview': [2.0, 12.0],
  'gemini-3.1-flash-lite-preview': [0.25, 1.5],
  'gemini-3.1-flash-image-preview': [0.5, 3.0],
  'gemini-3.1-flash-live-preview': [0.75, 4.5],
  'gemini-3.1-pro-preview': [2.0, 12.0],
  // OpenAI
  'gpt-4o': [2.5, 10.0],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2.0, 8.0],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  // Anthropic
  'claude-sonnet-4-20250514': [3.0, 15.0],
  'claude-haiku-4-5-20251001': [0.8, 4.0],
  // Groq (free tier / no cost)
  'llama-3.3-70b-versatile': [0, 0],
};
