/**
 * Data models for the AI-Media Literary Analysis System
 */

/**
 * Represents a text chunk from a PDF with metadata
 */
class TextChunk {
    constructor(id, text, metadata = {}) {
        this.id = id;               // Unique identifier for the chunk
        this.text = text;           // The actual text content
        this.metadata = {
            pageStart: metadata.pageStart || null,  // Starting page number
            pageEnd: metadata.pageEnd || null,      // Ending page number
            position: metadata.position || 0,       // Position in the document (0-based index)
            tokenCount: metadata.tokenCount || 0,   // Approximate token count
            ...metadata                             // Any other metadata
        };
        this.analysis = null;       // Will hold the analysis result for this chunk
    }
}

/**
 * Represents the analysis of a text chunk
 */
class ChunkAnalysis {
    constructor(chunkId) {
        this.chunkId = chunkId;           // Reference to parent chunk
        this.characters = [];              // Characters mentioned in this chunk
        this.events = [];                  // Key events in this chunk
        this.themes = [];                  // Themes identified in this chunk
        this.style = {                     // Stylistic elements
            tone: null,                    // Overall tone
            literaryDevices: [],           // Literary devices used
            narrativeVoice: null,          // First-person, third-person, etc.
            notable: []                    // Other notable style elements
        };
        this.keyQuotes = [];               // Important quotes from this chunk
        this.plotDevelopment = null;       // How this chunk advances the plot
        this.settings = [];                // Settings/locations mentioned
        this.timestamp = null;             // When the analysis was performed
        this.rawLlmOutput = null;          // Raw LLM output for debugging
    }
}

/**
 * Represents the full book analysis
 */
class BookAnalysis {
    constructor(bookInfo) {
        this.bookInfo = bookInfo;           // Basic book metadata
        this.chunks = [];                   // Array of TextChunk objects
        this.globalAnalysis = {             // Aggregated analysis
            title: bookInfo.title || null,  
            characters: [],                 // All characters with details
            mainCharacters: [],             // Primary characters
            supportingCharacters: [],       // Secondary characters
            plotSummary: null,              // Overall plot summary
            majorEvents: [],                // Significant events
            themes: [],                     // Primary themes
            settings: [],                   // All settings/locations
            timeline: [],                   // Chronological events
            style: {                        // Overall stylistic analysis
                tone: null,
                voice: null,
                notable: []
            },
            structure: {                    // Narrative structure
                type: null,                 // Linear, non-linear, etc.
                arc: null,                  // Story arc description
                segments: []                // Major structural segments (chapters, acts, etc.)
            },
            context: {                      // Contextual information
                historical: null,           // Historical context
                cultural: null,             // Cultural references
                authorContext: null         // Author's background context
            },
            perspectives: [],               // Different critical perspectives
            keyQuotes: [],                  // Most significant quotes
        };
        this.analysisStatus = {             // Tracks analysis progress
            chunksAnalyzed: 0,
            totalChunks: 0,
            startTime: null,
            endTime: null,
            status: 'pending',              // 'pending', 'in-progress', 'completed', 'failed'
            error: null
        };
    }
}

// Export models
module.exports = {
    TextChunk,
    ChunkAnalysis,
    BookAnalysis
}; 