/**
 * Synthesis service for the AI-Media Literary Analysis System
 * Combines individual chunk analyses into a unified book analysis
 */

const axios = require('axios');
const { BookAnalysis } = require('../models');
const logger = require('../logger'); // Import the logger

// Ollama API URL
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

/**
 * Synthesize all chunk analyses into a complete book analysis
 * @param {Array<TextChunk>} chunks - Array of text chunks with their analyses
 * @param {Object} bookInfo - Book information object
 * @returns {Promise<BookAnalysis>} - Complete book analysis
 */
async function synthesizeBookAnalysis(chunks, bookInfo) {
    // Create a new book analysis object
    const bookAnalysis = new BookAnalysis(bookInfo);
    bookAnalysis.chunks = chunks;
    
    // Set analysis status
    bookAnalysis.analysisStatus.startTime = new Date().toISOString();
    bookAnalysis.analysisStatus.totalChunks = chunks.length;
    bookAnalysis.analysisStatus.status = 'in-progress';
    
    try {
        // 1. Aggregate characters across all chunks
        aggregateCharacters(chunks, bookAnalysis);
        
        // 2. Aggregate themes
        aggregateThemes(chunks, bookAnalysis);
        
        // 3. Aggregate settings
        aggregateSettings(chunks, bookAnalysis);
        
        // 4. Create plot summary and timeline
        await createPlotSummary(chunks, bookAnalysis);
        
        // 5. Synthesize style analysis
        synthesizeStyle(chunks, bookAnalysis);
        
        // 6. Identify key quotes
        identifyKeyQuotes(chunks, bookAnalysis);
        
        // 7. Determine narrative structure
        await determineNarrativeStructure(chunks, bookAnalysis);
        
        // Mark analysis as complete
        bookAnalysis.analysisStatus.endTime = new Date().toISOString();
        bookAnalysis.analysisStatus.chunksAnalyzed = chunks.length;
        bookAnalysis.analysisStatus.status = 'completed';
        
        return bookAnalysis;
    } catch (error) {
        console.error('Error synthesizing book analysis:', error);
        bookAnalysis.analysisStatus.status = 'failed';
        bookAnalysis.analysisStatus.error = error.message;
        throw error;
    }
}

/**
 * Aggregate character information across all chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
function aggregateCharacters(chunks, bookAnalysis) {
    const characterMap = new Map();
    
    // Collect all character mentions
    chunks.forEach(chunk => {
        if (!chunk.analysis || !chunk.analysis.characters) return;
        
        chunk.analysis.characters.forEach(character => {
            if (!character.name) return;
            
            // Normalize character name for merging
            const normalizedName = normalizeCharacterName(character.name);
            
            if (characterMap.has(normalizedName)) {
                const existingChar = characterMap.get(normalizedName);
                
                // Merge descriptions if they differ
                if (character.description && 
                    character.description !== existingChar.description &&
                    !existingChar.description.includes(character.description)) {
                    existingChar.description += '. ' + character.description;
                }
                
                // Merge roles if they differ
                if (character.role && 
                    character.role !== existingChar.role &&
                    !existingChar.role.includes(character.role)) {
                    existingChar.role += '; ' + character.role;
                }
                
                // Count appearances
                existingChar.appearances = (existingChar.appearances || 1) + 1;
                
                // Add page references
                if (chunk.metadata.pageStart) {
                    if (!existingChar.pages) existingChar.pages = [];
                    if (!existingChar.pages.includes(chunk.metadata.pageStart)) {
                        existingChar.pages.push(chunk.metadata.pageStart);
                    }
                }
            } else {
                // Create new character entry
                const newCharacter = {
                    name: character.name,
                    description: character.description || '',
                    role: character.role || '',
                    appearances: 1,
                    pages: chunk.metadata.pageStart ? [chunk.metadata.pageStart] : []
                };
                characterMap.set(normalizedName, newCharacter);
            }
        });
    });
    
    // Convert map to array and sort by number of appearances
    const characters = Array.from(characterMap.values())
        .sort((a, b) => (b.appearances || 0) - (a.appearances || 0));
    
    // Set main and supporting characters based on frequency
    const mainCharacterCutoff = Math.max(
        3,  // At least 3 main characters
        Math.ceil(characters.length * 0.2)  // Or top 20%
    );
    
    bookAnalysis.globalAnalysis.characters = characters;
    bookAnalysis.globalAnalysis.mainCharacters = characters.slice(0, mainCharacterCutoff);
    bookAnalysis.globalAnalysis.supportingCharacters = characters.slice(mainCharacterCutoff);
}

/**
 * Normalize character names for merging
 * @param {string} name - Character name
 * @returns {string} - Normalized name
 */
function normalizeCharacterName(name) {
    return name.toLowerCase()
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')  // Remove punctuation
        .trim();
}

/**
 * Aggregate themes across all chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
function aggregateThemes(chunks, bookAnalysis) {
    const themeMap = new Map();
    
    // Collect all theme mentions
    chunks.forEach(chunk => {
        if (!chunk.analysis || !chunk.analysis.themes) return;
        
        chunk.analysis.themes.forEach(theme => {
            if (!theme.name) return;
            
            // Normalize theme name for merging
            const normalizedName = theme.name.toLowerCase().trim();
            
            if (themeMap.has(normalizedName)) {
                const existingTheme = themeMap.get(normalizedName);
                
                // Merge descriptions if they differ
                if (theme.description && 
                    theme.description !== existingTheme.description &&
                    !existingTheme.description.includes(theme.description)) {
                    existingTheme.description += '. ' + theme.description;
                }
                
                // Count occurrences
                existingTheme.occurrences = (existingTheme.occurrences || 1) + 1;
                
                // Add page references
                if (chunk.metadata.pageStart) {
                    if (!existingTheme.pages) existingTheme.pages = [];
                    if (!existingTheme.pages.includes(chunk.metadata.pageStart)) {
                        existingTheme.pages.push(chunk.metadata.pageStart);
                    }
                }
            } else {
                // Create new theme entry
                const newTheme = {
                    name: theme.name,
                    description: theme.description || '',
                    occurrences: 1,
                    pages: chunk.metadata.pageStart ? [chunk.metadata.pageStart] : []
                };
                themeMap.set(normalizedName, newTheme);
            }
        });
    });
    
    // Convert map to array and sort by number of occurrences
    const themes = Array.from(themeMap.values())
        .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0));
    
    bookAnalysis.globalAnalysis.themes = themes;
}

/**
 * Aggregate settings across all chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
function aggregateSettings(chunks, bookAnalysis) {
    const settingMap = new Map();
    
    // Collect all setting mentions
    chunks.forEach(chunk => {
        if (!chunk.analysis || !chunk.analysis.settings) return;
        
        chunk.analysis.settings.forEach(setting => {
            if (!setting.location) return;
            
            // Normalize location name for merging
            const normalizedName = setting.location.toLowerCase().trim();
            
            if (settingMap.has(normalizedName)) {
                const existingSetting = settingMap.get(normalizedName);
                
                // Merge descriptions if they differ
                if (setting.description && 
                    setting.description !== existingSetting.description &&
                    !existingSetting.description.includes(setting.description)) {
                    existingSetting.description += '. ' + setting.description;
                }
                
                // Count occurrences
                existingSetting.occurrences = (existingSetting.occurrences || 1) + 1;
                
                // Add page references
                if (chunk.metadata.pageStart) {
                    if (!existingSetting.pages) existingSetting.pages = [];
                    if (!existingSetting.pages.includes(chunk.metadata.pageStart)) {
                        existingSetting.pages.push(chunk.metadata.pageStart);
                    }
                }
            } else {
                // Create new setting entry
                const newSetting = {
                    location: setting.location,
                    description: setting.description || '',
                    occurrences: 1,
                    pages: chunk.metadata.pageStart ? [chunk.metadata.pageStart] : []
                };
                settingMap.set(normalizedName, newSetting);
            }
        });
    });
    
    // Convert map to array and sort by number of occurrences
    const settings = Array.from(settingMap.values())
        .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0));
    
    bookAnalysis.globalAnalysis.settings = settings;
}

/**
 * Create a plot summary and timeline from events across chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
async function createPlotSummary(chunks, bookAnalysis) {
    // 1. Collect all events with their positions
    const events = [];
    
    chunks.forEach((chunk, index) => {
        if (!chunk.analysis || !chunk.analysis.events) return;
        
        chunk.analysis.events.forEach(event => {
            if (!event.description) return;
            
            events.push({
                description: event.description,
                importance: event.importance || '',
                position: index,
                pageStart: chunk.metadata.pageStart,
                pageEnd: chunk.metadata.pageEnd
            });
        });
    });
    
    // Sort events by position
    events.sort((a, b) => a.position - b.position);
    
    // 2. Create timeline
    bookAnalysis.globalAnalysis.timeline = events.map(event => ({
        description: event.description,
        importance: event.importance,
        page: event.pageStart
    }));
    
    // 3. Identify major events (based on importance or explicit marking)
    const majorEvents = events.filter(event => 
        event.importance && 
        (event.importance.toLowerCase().includes('significant') ||
         event.importance.toLowerCase().includes('major') ||
         event.importance.toLowerCase().includes('important') ||
         event.importance.toLowerCase().includes('crucial'))
    );
    
    // If we don't have enough explicitly marked major events, choose some based on position
    if (majorEvents.length < 5) {
        // Select beginning, quarter, middle, three-quarter, and end events
        const positions = [0, 0.25, 0.5, 0.75, 1];
        
        positions.forEach(pos => {
            const index = Math.floor(pos * (events.length - 1));
            if (events[index] && !majorEvents.includes(events[index])) {
                majorEvents.push(events[index]);
            }
        });
    }
    
    bookAnalysis.globalAnalysis.majorEvents = majorEvents;
    
    // 4. Generate overall plot summary using LLM
    // Prepare a condensed event list to send to the LLM
    const eventSummaries = events.map(event => 
        `- ${event.description}${event.pageStart ? ` (Page ${event.pageStart})` : ''}`
    );
    
    // If we have a lot of events, sample them to avoid overwhelming the LLM
    const sampledEvents = eventSummaries.length > 50 
        ? sampleEvents(eventSummaries, 50) 
        : eventSummaries;
    
    const prompt = `
You are a literary analysis assistant tasked with creating a concise yet comprehensive plot summary.

Based on the chronological list of events below, create a coherent 2-3 paragraph plot summary that captures the narrative arc of the entire book. Focus on the major plot developments while maintaining narrative flow.

EVENTS:
${sampledEvents.join('\n')}

YOUR RESPONSE SHOULD:
1. Be approximately 2-3 paragraphs (200-400 words total)
2. Focus on the main narrative throughline
3. Include major conflicts, turning points, and resolution
4. Be written in present tense
5. Not include any direct quotes
6. Not discuss themes or characters separately from plot events

Respond with ONLY the plot summary paragraph, no additional explanations or introductions.`;

    try {
        const response = await axios.post(OLLAMA_API_URL, {
            model: OLLAMA_MODEL,
            prompt: prompt,
            stream: false
        });
        
        // Log the LLM response using our real-time logger
        logger.llm('Plot Summary', response.data.response);
        
        bookAnalysis.globalAnalysis.plotSummary = response.data.response.trim();
    } catch (error) {
        console.error('Error generating plot summary:', error);
        // Fallback to basic summary
        bookAnalysis.globalAnalysis.plotSummary = 
            "Failed to generate plot summary. Please review the timeline of events.";
    }
}

/**
 * Sample events from a list to get representative coverage
 * @param {Array<string>} events - List of event descriptions
 * @param {number} count - Number of events to sample
 * @returns {Array<string>} - Sampled events
 */
function sampleEvents(events, count) {
    if (events.length <= count) return events;
    
    const result = [];
    const step = events.length / count;
    
    // Always include first and last events
    result.push(events[0]);
    
    // Sample events at regular intervals
    for (let i = 1; i < count - 1; i++) {
        const index = Math.floor(i * step);
        result.push(events[index]);
    }
    
    // Add the last event
    result.push(events[events.length - 1]);
    
    return result;
}

/**
 * Synthesize style analysis across all chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
function synthesizeStyle(chunks, bookAnalysis) {
    // Collect all style information
    const tones = [];
    const voices = [];
    const literaryDevices = new Map();
    const notable = [];
    
    chunks.forEach(chunk => {
        if (!chunk.analysis || !chunk.analysis.style) return;
        
        // Collect tones
        if (chunk.analysis.style.tone) {
            tones.push(chunk.analysis.style.tone);
        }
        
        // Collect narrative voices
        if (chunk.analysis.style.narrativeVoice) {
            voices.push(chunk.analysis.style.narrativeVoice);
        }
        
        // Collect literary devices
        if (chunk.analysis.style.literaryDevices) {
            chunk.analysis.style.literaryDevices.forEach(device => {
                if (!device) return;
                
                const normalizedDevice = device.toLowerCase().trim();
                literaryDevices.set(normalizedDevice, 
                    (literaryDevices.get(normalizedDevice) || 0) + 1);
            });
        }
        
        // Collect notable style elements
        if (chunk.analysis.style.notable) {
            chunk.analysis.style.notable.forEach(item => {
                if (item && !notable.includes(item)) {
                    notable.push(item);
                }
            });
        }
    });
    
    // Determine predominant tone
    const toneFrequency = new Map();
    tones.forEach(tone => {
        const normalizedTone = tone.toLowerCase().trim();
        toneFrequency.set(normalizedTone, 
            (toneFrequency.get(normalizedTone) || 0) + 1);
    });
    
    // Get the most frequent tone
    const predominantTone = Array.from(toneFrequency.entries())
        .sort((a, b) => b[1] - a[1])[0] && Array.from(toneFrequency.entries())
        .sort((a, b) => b[1] - a[1])[0][0] || null;
    
    // Determine predominant voice
    const voiceFrequency = new Map();
    voices.forEach(voice => {
        const normalizedVoice = voice.toLowerCase().trim();
        voiceFrequency.set(normalizedVoice, 
            (voiceFrequency.get(normalizedVoice) || 0) + 1);
    });
    
    // Get the most frequent voice
    const predominantVoice = Array.from(voiceFrequency.entries())
        .sort((a, b) => b[1] - a[1])[0] && Array.from(voiceFrequency.entries())
        .sort((a, b) => b[1] - a[1])[0][0] || null;
    
    // Get the most common literary devices
    const commonDevices = Array.from(literaryDevices.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(entry => entry[0]);
    
    // Update book analysis
    bookAnalysis.globalAnalysis.style = {
        tone: predominantTone,
        voice: predominantVoice,
        literaryDevices: commonDevices,
        notable: notable.slice(0, 10) // Limit to top 10 notable elements
    };
}

/**
 * Identify key quotes across all chunks
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
function identifyKeyQuotes(chunks, bookAnalysis) {
    const allQuotes = [];
    
    // Collect all quotes with their metadata
    chunks.forEach(chunk => {
        if (!chunk.analysis || !chunk.analysis.keyQuotes) return;
        
        chunk.analysis.keyQuotes.forEach(quoteObj => {
            if (!quoteObj.quote) return;
            
            allQuotes.push({
                quote: quoteObj.quote,
                explanation: quoteObj.explanation || '',
                page: chunk.metadata.pageStart,
                chunkId: chunk.id
            });
        });
    });
    
    // Pick a diverse set of quotes (max 10)
    // We'll try to get quotes from different parts of the book
    const selectedQuotes = [];
    
    if (allQuotes.length <= 10) {
        // If we have 10 or fewer quotes, use them all
        selectedQuotes.push(...allQuotes);
    } else {
        // Divide the book into sections and take quotes from each
        const numSections = 5;
        const quotesPerSection = 2;
        
        // Sort quotes by page number
        allQuotes.sort((a, b) => (a.page || 0) - (b.page || 0));
        
        // Calculate section size
        const sectionSize = Math.ceil(allQuotes.length / numSections);
        
        // Select quotes from each section
        for (let i = 0; i < numSections; i++) {
            const sectionStart = i * sectionSize;
            const sectionEnd = Math.min((i + 1) * sectionSize, allQuotes.length);
            const sectionQuotes = allQuotes.slice(sectionStart, sectionEnd);
            
            // Add up to quotesPerSection quotes from this section
            for (let j = 0; j < Math.min(quotesPerSection, sectionQuotes.length); j++) {
                selectedQuotes.push(sectionQuotes[j]);
            }
        }
    }
    
    bookAnalysis.globalAnalysis.keyQuotes = selectedQuotes;
}

/**
 * Determine the narrative structure of the book
 * @param {Array<TextChunk>} chunks - Array of chunks with analyses
 * @param {BookAnalysis} bookAnalysis - Book analysis object to update
 */
async function determineNarrativeStructure(chunks, bookAnalysis) {
    // Extract plot development information from all chunks
    const plotDevelopments = chunks.map((chunk, index) => {
        return {
            index,
            chunkId: chunk.id,
            development: chunk.analysis && chunk.analysis.plotDevelopment ? chunk.analysis.plotDevelopment : '',
            pageStart: chunk.metadata.pageStart,
            pageEnd: chunk.metadata.pageEnd
        };
    }).filter(item => item.development);
    
    // Prepare condensed plot developments to send to LLM
    const plotSummaries = plotDevelopments.map(dev => 
        `- ${dev.development}${dev.pageStart ? ` (Pages ${dev.pageStart}-${dev.pageEnd || dev.pageStart})` : ''}`
    );
    
    // If we have a lot of developments, sample them
    const sampledDevelopments = plotSummaries.length > 40 
        ? sampleEvents(plotSummaries, 40) 
        : plotSummaries;
    
    const prompt = `
You are a literary analysis assistant tasked with determining the narrative structure.

Based on the following plot developments across the book, identify:
1. The type of narrative structure (e.g., linear, non-linear, frame story, epistolary, etc.)
2. The story arc or dramatic structure (e.g., exposition, rising action, climax, falling action, resolution)
3. Major structural segments or divisions in the narrative

PLOT DEVELOPMENTS:
${sampledDevelopments.join('\n')}

FORMAT YOUR RESPONSE AS A VALID JSON OBJECT with the following structure:
{
  "type": "Type of narrative structure (linear, non-linear, etc.)",
  "arc": "Description of the story arc/dramatic structure",
  "segments": [
    {
      "name": "Segment name (e.g., Exposition, Act 1, etc.)",
      "description": "Brief description of what happens in this segment",
      "approximate_location": "Beginning/early middle/middle/late middle/end of the book"
    }
  ]
}

Return ONLY the valid JSON object with no additional text.`;

    try {
        const response = await axios.post(OLLAMA_API_URL, {
            model: OLLAMA_MODEL,
            prompt: prompt,
            stream: false
        });
        
        // Log the LLM response using our real-time logger
        logger.llm('Narrative Structure', response.data.response);
        
        // Parse the response
        const rawResponse = response.data.response.trim();
        
        // Extract JSON from the response
        const jsonMatch = rawResponse.match(/```json\n([\s\S]*?)\n```/) || 
                          rawResponse.match(/```\n([\s\S]*?)\n```/) ||
                          rawResponse.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);
            
            bookAnalysis.globalAnalysis.structure = {
                type: parsed.type || null,
                arc: parsed.arc || null,
                segments: parsed.segments || []
            };
        } else {
            // Fallback if JSON parsing fails
            console.warn('Failed to parse narrative structure JSON, using raw response');
            bookAnalysis.globalAnalysis.structure = {
                type: 'Unknown',
                arc: rawResponse,
                segments: []
            };
        }
    } catch (error) {
        console.error('Error determining narrative structure:', error);
        // Fallback
        bookAnalysis.globalAnalysis.structure = {
            type: 'Unable to determine',
            arc: 'Error in analysis',
            segments: []
        };
    }
}

module.exports = {
    synthesizeBookAnalysis
}; 