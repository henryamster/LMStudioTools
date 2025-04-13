// Gemma3LMStudio.ts

import { LMStudioClient } from '@lmstudio/sdk';

// --- Interfaces ---
export interface HistoryMessage {
    role: "system" | "user" | "assistant";
    content: string;
    name?: string; // To identify which assistant spoke
}

export interface LMStudioConfig {
    baseUrl: string;
    apiKey?: string;
    timeout?: number;
    /** The default model identifier for chat/text generation (e.g., 'gemma-3-27b-it') */
    modelIdentifier?: string;
}

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
    role: MessageRole;
    content: string;
}

export interface ChatChoice {
    index: number;
    finish_reason: string;
    message: ChatMessage;
}

export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// --- Class Implementation ---
export class Gemma3LMStudio {
    private client: LMStudioClient;
    private config: LMStudioConfig;

    constructor(config: LMStudioConfig) {
        this.config = config;
        this.client = new LMStudioClient({
            baseUrl: config.baseUrl,
        });
    }

    async chatCompletion(
        messages: ChatMessage[],
        temperature: number = 0.7,
        maxTokens: number = 512,
        stream: boolean = false,
        model?: string
    ): Promise<ChatCompletionResponse> {
        const effectiveModel = model || this.config.modelIdentifier;

        if (!effectiveModel) {
            throw new Error("No chat model identifier specified in config or request.");
        }

        const modelInstance = await this.client.llm.model(effectiveModel);
        const prompt = messages.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');

        console.log(`[LMStudio] Sending chat request with model ${effectiveModel}`);
        const result = await modelInstance.respond(prompt, {
            temperature,
            maxTokens: maxTokens, // Corrected property name
        });

        return {
            id: Date.now().toString(), // Generate a unique ID since 'id' is not available
            object: 'chat.completion',
            created: Date.now(),
            model: effectiveModel,
            choices: [
                {
                    index: 0,
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: result.content, // Use the 'content' property from PredictionResult
                    },
                },
            ],
        };
    }
}