// server.ts

import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
// Assuming Gemma3LMStudio exports the necessary types
import { Gemma3LMStudio, LMStudioConfig, ChatMessage as ApiChatMessage, MessageRole } from './Gemma3LMStudio';

// --- Configuration ---
const PORT: number = 8080;
// Use the Deepseek model as default
const DEFAULT_CHAT_MODEL = "gemma-3-27b-it";
const ALTERNATIVE_CHAT_MODEL = "gemma-3-27b-it";

const LMSTUDIO_CONFIG: LMStudioConfig = { baseUrl: 'ws://localhost:1234', modelIdentifier: DEFAULT_CHAT_MODEL };
const lmStudio = new Gemma3LMStudio(LMSTUDIO_CONFIG);

interface Profile { name: string; personality: string; }
let profiles: Profile[] = [
    { name: "Alice", personality: "You are Alice, a friendly and cheerful assistant who loves helping people." },
    { name: "Bob", personality: "You are Bob, a sarcastic and witty assistant who enjoys making clever remarks." },
    { name: "Charlie", personality: "You are Charlie, a thoughtful assistant who always provides deep insights." }
];

// --- <<< NEW: Chat History Management >>> ---
interface HistoryMessage {
    role: "system" | "user" | "assistant";
    content: string;
    name?: string; // Optional: Identify assistant speaker
}
let chatHistory: HistoryMessage[] = [];
const MAX_HISTORY_LENGTH = 80; // Keep the last N messages (user + assistant turns)

function limitChatHistory() {
    if (chatHistory.length > MAX_HISTORY_LENGTH) {
        chatHistory = chatHistory.slice(-MAX_HISTORY_LENGTH); // Keep the most recent N messages
        console.log(`Chat history trimmed to last ${MAX_HISTORY_LENGTH} messages.`);
    }
}

/**
 * Helper function to process <think> tags and replace Markdown **bold** with <strong> HTML tags.
 * If <think> tags cannot be cleanly separated, return null.
 */
function processContent(content: string): { mainContent: string; thoughts: string[] } | null {
    const thoughts: string[] = [];
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g; // Match <think>...</think> tags
    let mainContent = '';
    let lastIndex = 0;

    let match;
    while ((match = thinkRegex.exec(content)) !== null) {
        // Extract text before the <think> tag
        mainContent += content.substring(lastIndex, match.index);

        // Extract the thought content
        const thought = match[1].trim();
        if (thought) {
            thoughts.push(thought);
        }

        // Update the last index to continue processing
        lastIndex = thinkRegex.lastIndex;
    }

    // Add any remaining text after the last <think> tag
    mainContent += content.substring(lastIndex);

    // If no valid <think> tags were found, return null
    if (thoughts.length === 0) {
        return null;
    }

    // Replace Markdown **bold** with <strong> tags in the main content
    mainContent = mainContent.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    return { mainContent: mainContent.trim(), thoughts };
}

/**
 * Helper function to truncate overly long responses.
 */
function truncateResponse(content: string, maxLength: number): string {
    return content.length > maxLength ? content.slice(0, maxLength) + '...' : content;
}

/**
 * Helper function to filter and summarize thoughts.
 */
function processThoughts(thoughts: string[]): string[] {
    const uniqueThoughts = Array.from(new Set(thoughts)); // Remove duplicates
    return uniqueThoughts.slice(0, 5); // Limit to 5 thoughts for brevity
}

/**
 * Helper function to validate and refine the AI's response.
 * If the response is incomplete or doesn't align with the system prompt, make an additional API call.
 */
async function refineResponse(
    profile: Profile,
    userContent: string,
    aiContent: string,
    modelToUse: string
): Promise<{ mainContent: string; thoughts: string[] } | null> {
    const processed = processContent(aiContent);
    if (processed) {
        // If the response is valid and complete, return it as is
        return processed;
    }

    console.warn(`[${profile.name}] Response validation failed. Refining response...`);

    // Make an additional API call to clarify or complete the response
    const clarificationPrompt = `The previous response was incomplete or unclear. Please refine the response to the following question: "${userContent}". Ensure the response is concise, conversational, and aligned with the personality of ${profile.name}.`;
    const clarificationMessages: ApiChatMessage[] = [
        { role: "system", content: `You are ${profile.name}. ${profile.personality}` },
        { role: "user", content: clarificationPrompt }
    ];

    try {
        const refinedResponse = await lmStudio.chatCompletion(clarificationMessages, 0.7, 512, false, modelToUse);
        if (refinedResponse.choices[0]?.message?.content) { // Guaranteed to have choices
            return processContent(refinedResponse.choices[0].message.content);
        }
    } catch (error) {
        console.error(`[${profile.name}] Error during response refinement:`, error);
    }

    return null; // Return null if refinement fails
}

// --- HTTP Server & WebSocket Setup ---
const httpServer = http.createServer((req, res) => {
    const filePath = req.url === '/' || req.url === '/index.html'
        ? path.join(__dirname, 'index.html') // Serve the main HTML file
        : path.join(__dirname, req.url || ''); // Serve other requested files

    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`Error serving file: ${filePath}`, err);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        // Determine the content type based on the file extension
        const ext = path.extname(filePath).toLowerCase();
        const contentType = ext === '.html' ? 'text/html' :
                            ext === '.css' ? 'text/css' :
                            ext === '.js' ? 'application/javascript' :
                            'text/plain';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
    if (request.headers['upgrade']?.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

function broadcastProfilesUpdate() {
    const message = JSON.stringify({ type: 'profilesUpdate', profiles });
    console.log(`Broadcasting profile update to ${wss.clients.size} clients.`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Add a global variable to store the chat room topic
let chatRoomTopic = "";

// Ensure default participants are sent to the client on connection
wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected via WebSocket');
    ws.send(JSON.stringify({ type: 'profilesUpdate', profiles })); // Send default participants

    ws.on('message', async (message: Buffer) => {
        let parsedMessage: any;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log('Received:', parsedMessage);

            if (parsedMessage.type === 'setTopic') {
                chatRoomTopic = parsedMessage.topic || "";
                console.log(`Chat room topic set to: ${chatRoomTopic}`);
                ws.send(JSON.stringify({ type: 'info', message: `Chat room topic updated to: ${chatRoomTopic}` }));
                return;
            }

            if (parsedMessage.type === 'removePersonality') {
                const nameToRemove = parsedMessage.name;
                const initialLength = profiles.length;
                profiles = profiles.filter(profile => profile.name !== nameToRemove);

                if (profiles.length < initialLength) {
                    console.log(`Removed personality: ${nameToRemove}`);
                    broadcastProfilesUpdate(); // Notify all clients
                } else {
                    console.warn(`Personality "${nameToRemove}" not found.`);
                    ws.send(JSON.stringify({ type: 'error', message: `Personality "${nameToRemove}" not found.` }));
                }
            } else if (parsedMessage.type === 'addPersonality') {
                const newProfile = parsedMessage.profile;
                if (newProfile && newProfile.name && newProfile.personality) {
                    if (!profiles.some(profile => profile.name === newProfile.name)) {
                        profiles.push(newProfile);
                        console.log(`Added personality: ${newProfile.name}`);
                        broadcastProfilesUpdate(); // Notify all clients
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: `Personality "${newProfile.name}" already exists.` }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid personality data.' }));
                }
            } else if (parsedMessage.type === 'user') {
                const userContent: string = parsedMessage.content.trim();
                const target: string | undefined = parsedMessage.target?.toLowerCase();
                const modelPreference: string | undefined = parsedMessage.model?.toLowerCase();

                // Check for @ mentions in the user content
                const mentionMatch = userContent.match(/^@([a-zA-Z0-9_]+):\s*(.*)$/);
                let mentionedName: string | undefined;
                let actualContent = userContent;

                if (mentionMatch) {
                    mentionedName = mentionMatch[1];
                    actualContent = mentionMatch[2];
                }

                const targetProfilesForChat = profiles.filter(profile => 
                    (target === 'all' || profile.name.toLowerCase() === target) &&
                    (!mentionedName || profile.name.toLowerCase() === mentionedName.toLowerCase())
                );

                if (targetProfilesForChat.length === 0) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `No matching personalities found for target '${parsedMessage.target}' or mention '${mentionedName}'.`
                    }));
                    return;
                }

                const modelToUse = modelPreference === 'alternative' ? ALTERNATIVE_CHAT_MODEL : DEFAULT_CHAT_MODEL;

                for (const profile of targetProfilesForChat) {
                    const systemMessage: ApiChatMessage = {
                        role: "system",
                        content: `
                        You are a participant in a group chat. Your name is [${profile.name}]. Your personality is described as [${profile.personality}].
                        The current topic of the chat room is: "${chatRoomTopic}".
                        Please respond naturally and conversationally, as if you were a real person with this personality.
                        Avoid generic or overly formal responses. Use a tone and style that matches your personality.
                        Here is the chat history:
                        ${chatHistory.map(msg => `${msg.role === 'user' ? 'User' : msg.name || profile.name}: ${msg.content}`).join('\n')}
                        User: ${actualContent}
                        `
                    };

                    const messagesForAPI: ApiChatMessage[] = [
                        systemMessage,
                        { role: 'user', content: actualContent }
                    ];

                    console.log(`[LLM Interaction] Sending prompt to LLM: ${JSON.stringify(messagesForAPI)}`);

                    lmStudio.chatCompletion(messagesForAPI, 0.7, 512, true, modelToUse)
                        .then(async (response: any) => {
                            console.log(`[LLM Interaction] Received response from LLM: ${JSON.stringify(response)}`);
                            if (response?.choices?.[0]?.message?.content) {
                                const aiContent = response.choices[0].message.content;
                                const skipInvalidThoughts = parsedMessage.skipInvalidThoughts === true;

                                const processed = processContent(aiContent);
                                if (processed) {
                                    const truncatedContent = truncateResponse(processed.mainContent, 2000);
                                    chatHistory.push({ role: 'assistant', content: truncatedContent, name: profile.name });
                                    limitChatHistory();

                                    try {
                                        console.log(`[LLM Interaction] Sending processed response to client: ${JSON.stringify({
                                            type: 'ai',
                                            name: profile.name,
                                            content: truncatedContent,
                                            thoughts: processed.thoughts,
                                            modelUsed: modelToUse,
                                            target: target === 'all' ? 'All participants' : profile.name
                                        })}`);
                                        ws.send(JSON.stringify({
                                            type: 'ai',
                                            name: profile.name,
                                            content: truncatedContent,
                                            thoughts: processed.thoughts,
                                            modelUsed: modelToUse,
                                            target: target === 'all' ? 'All participants' : profile.name
                                        }));
                                        console.log(`[${profile.name}] Streaming response sent.`);
                                    } catch (sendError) {
                                        console.error(`[${profile.name}] Error sending message to client:`, sendError);
                                    }
                                } else {
                                    if (skipInvalidThoughts) {
                                        console.warn(`[${profile.name}] Skipping response due to missing or invalid <think> tags (as requested by client).`);
                                    } else {
                                        console.warn(`[${profile.name}] Skipping response due to missing or invalid <think> tags, but sending anyway since client allows it.`);
                                        try {
                                            console.log(`[LLM Interaction] Sending unprocessed response to client: ${JSON.stringify({
                                                type: 'ai',
                                                name: profile.name,
                                                content: truncateResponse(aiContent, 2000),
                                                thoughts: [],
                                                modelUsed: modelToUse,
                                                target: target === 'all' ? 'All participants' : profile.name
                                            })}`);
                                            ws.send(JSON.stringify({
                                                type: 'ai',
                                                name: profile.name,
                                                content: truncateResponse(aiContent, 2000),
                                                thoughts: [],
                                                modelUsed: modelToUse,
                                                target: target === 'all' ? 'All participants' : profile.name
                                            }));
                                            console.log(`[${profile.name}] Streaming response sent (despite invalid thoughts, as requested by client).`);
                                        } catch (sendError) {
                                            console.error(`[${profile.name}] Error sending message to client:`, sendError);
                                        }
                                    }
                                }
                            }
                        })
                        .catch((err: Error) => {
                            console.error(`[${profile.name}] Error during streaming response:`, err);
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: `Error generating response for ${profile.name}: ${err.message}`
                            }));
                        });
                }
            } 
            // Update the `spawnParticipants` logic to batch requests
            else if (parsedMessage.type === 'spawnParticipants') {
                const { prompt, count } = parsedMessage;
                if (!prompt || typeof prompt !== 'string' || !count || typeof count !== 'number' || count <= 0) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid spawnParticipants data.' }));
                    return;
                }

                ws.send(JSON.stringify({ type: 'info', message: 'Creating participants...' }));

                const createParticipants = async () => {
                    const systemMessage: ApiChatMessage = {
                        role: "system",
                        content: `You are tasked with creating unique personalities for a group of participants. The participants should align with the following prompt: ${prompt}. Respond in the following format:

                        Name: [Participant's Name]
                        Personality: [A brief description of the participant's personality]

                        Generate ${count} unique participants. Ensure that each participant has a distinct name and personality.`
                    };

                    try {
                        const response = await lmStudio.chatCompletion([
                            systemMessage
                        ], 0.7, 512, false, DEFAULT_CHAT_MODEL);

                        const generatedContent = response.choices[0]?.message?.content;
                        if (generatedContent) {
                            const participants = generatedContent.split(/\n\n/).map(participantBlock => {
                                const nameMatch = participantBlock.match(/^Name:\s*(.+)$/m);
                                const personalityMatch = participantBlock.match(/^Personality:\s*(.+)$/m);

                                if (nameMatch && personalityMatch) {
                                    return {
                                        name: nameMatch[1].trim(),
                                        personality: personalityMatch[1].trim()
                                    };
                                }
                                return null;
                            }).filter(Boolean);

                            if (participants.length > 0) {
                                profiles = profiles.concat(participants as Profile[]);
                                console.log(`Added ${participants.length} new participants.`);
                                broadcastProfilesUpdate(); // Notify all clients
                            } else {
                                ws.send(JSON.stringify({ type: 'error', message: 'Failed to parse participants from response.' }));
                            }
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Empty or undefined content from LLM response.' }));
                        }
                    } catch (error) {
                        console.error('Error generating participants:', error);
                        ws.send(JSON.stringify({ type: 'error', message: 'Error generating participants.' }));
                    }
                };

                createParticipants();
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message type.' }));
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
    });
});

// Start the HTTP Server
httpServer.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
console.log("Server setup complete, starting listener...");