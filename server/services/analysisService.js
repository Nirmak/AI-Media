/**
 * Analysis service for the AI-Media Literary Analysis System
 */

const axios = require('axios');
const { ChunkAnalysis } = require('../models');
const logger = require('../logger'); // Import the logger

// Ollama API URL
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

/**
 * Remove content between <think> and </think> tags
 * @param {string} text - The text to clean
 * @returns {string} - The cleaned text
 */
function removeThinkingContent(text) {
    if (!text) return text;
    return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}

/**
 * Analyze a text chunk and extract literary elements
 * @param {TextChunk} chunk - The text chunk to analyze
 * @returns {Promise<ChunkAnalysis>} - The analysis results
 */
async function analyzeChunk(chunk) {
    try {
        const analysis = new ChunkAnalysis(chunk.id);
        
        // Create the analysis prompt
        const prompt = createAnalysisPrompt(chunk);
        
        // Call Ollama API
        const response = await axios.post(OLLAMA_API_URL, {
            model: OLLAMA_MODEL,
            prompt: prompt,
            stream: false
        });
        
        // Process the response
        let rawOutput = response.data.response;
        
        // Remove thinking content
        rawOutput = removeThinkingContent(rawOutput);
        
        // Log the LLM response using our real-time logger
        logger.llm(`Chunk Analysis: ${chunk.id}`, rawOutput);
        
        analysis.rawLlmOutput = rawOutput;
        
        // Parse the JSON response
        try {
            // Look for JSON in the response
            const jsonMatch = rawOutput.match(/```json\n([\s\S]*?)\n```/) || 
                             rawOutput.match(/```\n([\s\S]*?)\n```/) ||
                             rawOutput.match(/\{[\s\S]*\}/);
            
            if (jsonMatch) {
                const jsonStr = jsonMatch[1] || jsonMatch[0];
                const parsed = JSON.parse(jsonStr);
                
                // Map the parsed JSON to our analysis structure
                if (parsed.characters) analysis.characters = parsed.characters;
                if (parsed.events) analysis.events = parsed.events;
                if (parsed.themes) analysis.themes = parsed.themes;
                if (parsed.style) analysis.style = parsed.style;
                if (parsed.keyQuotes) analysis.keyQuotes = parsed.keyQuotes;
                if (parsed.plotDevelopment) analysis.plotDevelopment = parsed.plotDevelopment;
                if (parsed.settings) analysis.settings = parsed.settings;
            } else {
                console.warn(`Failed to extract JSON from LLM response for chunk ${chunk.id}`);
                // Try to extract information using regex or other methods
                extractInformationFromText(rawOutput, analysis);
            }
        } catch (parseError) {
            console.error(`JSON parsing error for chunk ${chunk.id}:`, parseError);
            // Fallback to extracting information from text
            extractInformationFromText(rawOutput, analysis);
        }
        
        // Set timestamp
        analysis.timestamp = new Date().toISOString();
        
        return analysis;
    } catch (error) {
        console.error(`Error analyzing chunk ${chunk.id}:`, error);
        throw error;
    }
}

/**
 * Create an analysis prompt for the LLM
 * @param {TextChunk} chunk - The text chunk to analyze
 * @returns {string} - The formatted prompt
 */
function createAnalysisPrompt(chunk) {
    return `You are a literary analysis assistant that extracts key information from text segments.
Analyze the following text segment (Pages: ${chunk.metadata.pageStart || 'unknown'}-${chunk.metadata.pageEnd || 'unknown'}) and extract the following elements:

1. CHARACTERS: Identify characters mentioned by name, with brief descriptions and roles
2. EVENTS: List key plot events occurring in this segment
3. THEMES: Identify major and minor themes expressed
4. STYLE: Note tone, literary devices, narrative voice, or unique stylistic elements
5. KEY QUOTES: Identify up to 3 significant quotes in this segment with brief explanations of their importance
6. PLOT DEVELOPMENT: Briefly describe how this segment advances the overall narrative
7. SETTINGS: Identify locations or settings described

TEXT SEGMENT:
----------------
${chunk.text}
----------------

FORMAT YOUR RESPONSE AS A VALID JSON OBJECT with the following structure:
{
  "characters": [
    {"name": "Character Name", "description": "Brief description", "role": "Role in story"}
  ],
  "events": [
    {"description": "Event description", "importance": "Why this matters"}
  ],
  "themes": [
    {"name": "Theme name", "description": "How this theme is expressed"}
  ],
  "style": {
    "tone": "Overall tone of this segment",
    "literaryDevices": ["device1", "device2"],
    "narrativeVoice": "POV/narrative approach",
    "notable": ["other notable style elements"]
  },
  "keyQuotes": [
    {"quote": "The exact quote", "explanation": "Why this quote matters"}
  ],
  "plotDevelopment": "How this segment advances the narrative",
  "settings": [
    {"location": "Setting name", "description": "Setting description"}
  ]
}

IMPORTANT:
- Return ONLY valid JSON that can be parsed. Don't include extra text or explanations outside the JSON.
- Do not include any thinking, reasoning process, or preamble text.
- If you can't find information for a category, use empty arrays or null values.
- Be specific and concise in your analysis.
- Only include elements explicitly mentioned or strongly implied in the text segment.`;
}

/**
 * Extract literary information from unstructured text response
 * @param {string} text - The LLM response text
 * @param {ChunkAnalysis} analysis - The analysis object to populate
 */
function extractInformationFromText(text, analysis) {
    // Extract characters
    const characterSection = extractSection(text, 'CHARACTERS', 'EVENTS');
    if (characterSection) {
        const characterLines = characterSection.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'));
        analysis.characters = characterLines.map(line => {
            const content = line.replace(/^[-*]\s*/, '').trim();
            return { 
                name: extractNameFromLine(content),
                description: content 
            };
        });
    }
    
    // Extract events
    const eventsSection = extractSection(text, 'EVENTS', 'THEMES');
    if (eventsSection) {
        const eventLines = eventsSection.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'));
        analysis.events = eventLines.map(line => {
            const content = line.replace(/^[-*]\s*/, '').trim();
            return { description: content };
        });
    }
    
    // Extract themes
    const themesSection = extractSection(text, 'THEMES', 'STYLE');
    if (themesSection) {
        const themeLines = themesSection.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'));
        analysis.themes = themeLines.map(line => {
            const content = line.replace(/^[-*]\s*/, '').trim();
            // Try to extract theme name and description
            const themeMatch = content.match(/^([^:]+):\s*(.+)$/);
            if (themeMatch) {
                return { 
                    name: themeMatch[1].trim(), 
                    description: themeMatch[2].trim() 
                };
            }
            return { name: content };
        });
    }
    
    // Extract style information
    const styleSection = extractSection(text, 'STYLE', 'KEY QUOTES');
    if (styleSection) {
        // Try to identify tone
        const toneMatch = styleSection.match(/tone:?\s*([^.]+)/i);
        if (toneMatch) {
            analysis.style.tone = toneMatch[1].trim();
        }
        
        // Try to identify narrative voice
        const voiceMatch = styleSection.match(/voice:?\s*([^.]+)/i) || 
                           styleSection.match(/narrative:?\s*([^.]+)/i) ||
                           styleSection.match(/pov:?\s*([^.]+)/i);
        if (voiceMatch) {
            analysis.style.narrativeVoice = voiceMatch[1].trim();
        }
        
        // Extract literary devices
        const deviceLines = styleSection.split('\n')
            .filter(line => line.toLowerCase().includes('device') || 
                           line.includes('imagery') || 
                           line.includes('metaphor') || 
                           line.includes('simile'));
        
        if (deviceLines.length > 0) {
            analysis.style.literaryDevices = deviceLines.map(line => {
                return line.replace(/^[-*]\s*/, '').trim();
            });
        }
    }
    
    // Extract key quotes
    const quotesSection = extractSection(text, 'KEY QUOTES', 'PLOT DEVELOPMENT');
    if (quotesSection) {
        // Look for quotes in quotation marks
        const quoteMatches = quotesSection.match(/"([^"]+)"/g) || quotesSection.match(/"([^"]+)"/g);
        if (quoteMatches) {
            analysis.keyQuotes = quoteMatches.map(match => {
                return { 
                    quote: match.replace(/^[""]|[""]$/g, ''),
                    explanation: '' // Can't easily extract explanation
                };
            });
        }
    }
    
    // Extract plot development
    const plotSection = extractSection(text, 'PLOT DEVELOPMENT', 'SETTINGS');
    if (plotSection) {
        analysis.plotDevelopment = plotSection.trim();
    }
    
    // Extract settings
    const settingsSection = extractSection(text, 'SETTINGS', null);
    if (settingsSection) {
        const settingLines = settingsSection.split('\n').filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'));
        analysis.settings = settingLines.map(line => {
            const content = line.replace(/^[-*]\s*/, '').trim();
            return { location: content };
        });
    }
}

/**
 * Extract a section from text between two headers
 * @param {string} text - The full text 
 * @param {string} startSection - The section header to start from
 * @param {string|null} endSection - The section header that ends this section, or null if last section
 * @returns {string|null} - The extracted section or null if not found
 */
function extractSection(text, startSection, endSection) {
    const startPattern = new RegExp(`${startSection}:?\\s*`, 'i');
    const startMatch = text.match(startPattern);
    
    if (!startMatch) return null;
    
    const startIndex = startMatch.index + startMatch[0].length;
    let endIndex;
    
    if (endSection) {
        const endPattern = new RegExp(`${endSection}:?\\s*`, 'i');
        const endMatch = text.substring(startIndex).match(endPattern);
        endIndex = endMatch ? startIndex + endMatch.index : text.length;
    } else {
        endIndex = text.length;
    }
    
    return text.substring(startIndex, endIndex).trim();
}

/**
 * Extract a character name from a description line
 * @param {string} line - The description line
 * @returns {string} - The extracted name
 */
function extractNameFromLine(line) {
    // Try to find the name at the beginning of the line
    const nameMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
    if (nameMatch) return nameMatch[1];
    
    // Try to find a name in quotes or brackets
    const specialMatch = line.match(/"([^"]+)"/) || line.match(/\[([^\]]+)\]/) || line.match(/\(([^)]+)\)/);
    if (specialMatch) return specialMatch[1];
    
    // Just return the first few words
    return line.split(' ').slice(0, 3).join(' ');
}

/**
 * Analyze multiple chunks in sequence
 * @param {Array<TextChunk>} chunks - Array of text chunks to analyze 
 * @param {function} progressCallback - Optional callback function for progress updates
 * @returns {Promise<Array<ChunkAnalysis>>} - Array of analyses
 */
async function analyzeChunks(chunks, progressCallback = null) {
    const analyses = [];
    
    for (let i = 0; i < chunks.length; i++) {
        try {
            const analysis = await analyzeChunk(chunks[i]);
            analyses.push(analysis);
            
            // Update progress
            if (progressCallback) {
                progressCallback({
                    current: i + 1,
                    total: chunks.length,
                    percentage: Math.round(((i + 1) / chunks.length) * 100),
                    lastAnalyzed: chunks[i].id
                });
            }
            
        } catch (error) {
            console.error(`Error analyzing chunk ${chunks[i].id}:`, error);
            // Continue with next chunk despite error
        }
    }
    
    return analyses;
}

module.exports = {
    analyzeChunk,
    analyzeChunks
}; 