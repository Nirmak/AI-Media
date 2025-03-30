/**
 * Text processing utilities for the AI-Media Literary Analysis System
 */

const { TextChunk } = require('../models');

/**
 * Roughly estimate the number of tokens in a text 
 * This is a simple approximation, not as accurate as a true tokenizer
 * @param {string} text - Text to estimate token count for
 * @returns {number} - Estimated token count
 */
function estimateTokenCount(text) {
    // Very rough approximation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
}

/**
 * Split text into chunks based on semantic boundaries
 * @param {string} text - Full text to split
 * @param {Object} options - Chunking options
 * @param {number} options.maxTokens - Maximum tokens per chunk (default: 1000)
 * @param {number} options.minTokens - Minimum tokens per chunk (default: 100)
 * @param {boolean} options.preserveParagraphs - Try to keep paragraphs together (default: true)
 * @returns {Array<TextChunk>} - Array of TextChunk objects
 */
function chunkText(text, { maxTokens = 1000, minTokens = 100, preserveParagraphs = true } = {}) {
    // Split text into paragraphs
    const paragraphs = text.split(/\n\s*\n/);
    
    const chunks = [];
    let currentChunk = '';
    let chunkId = 0;
    let position = 0;
    let pageMarkers = extractPageMarkers(text);
    
    // Function to create a new chunk with metadata
    const createChunk = (content, endPos) => {
        const chunkTokens = estimateTokenCount(content);
        if (chunkTokens < minTokens && chunks.length > 0) {
            // If chunk is too small, append to previous chunk
            const previousChunk = chunks[chunks.length - 1];
            previousChunk.text += '\n\n' + content;
            // Update token count
            previousChunk.metadata.tokenCount = estimateTokenCount(previousChunk.text);
            return;
        }
        
        // Determine page numbers for this chunk
        const { startPage, endPage } = findPageBoundaries(position, endPos, pageMarkers);
        
        // Create new chunk with metadata
        const chunk = new TextChunk(
            `chunk-${chunkId++}`,
            content,
            {
                position: position,
                tokenCount: chunkTokens,
                pageStart: startPage,
                pageEnd: endPage
            }
        );
        
        chunks.push(chunk);
    };
    
    // Process paragraphs
    for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i].trim();
        if (!paragraph) continue;
        
        const paragraphTokens = estimateTokenCount(paragraph);
        const currentChunkTokens = estimateTokenCount(currentChunk);
        
        // If adding this paragraph would exceed maxTokens
        if (currentChunk && currentChunkTokens + paragraphTokens > maxTokens) {
            // Save current chunk
            createChunk(currentChunk, position);
            currentChunk = paragraph;
            position += currentChunkTokens;
        } 
        // If this single paragraph exceeds maxTokens
        else if (paragraphTokens > maxTokens) {
            // If we have accumulated content, create a chunk
            if (currentChunk) {
                createChunk(currentChunk, position);
                position += currentChunkTokens;
                currentChunk = '';
            }
            
            // Split the large paragraph into sentences
            const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
            let sentenceChunk = '';
            
            for (const sentence of sentences) {
                const sentenceTokens = estimateTokenCount(sentence);
                const sentenceChunkTokens = estimateTokenCount(sentenceChunk);
                
                if (sentenceChunk && sentenceChunkTokens + sentenceTokens > maxTokens) {
                    createChunk(sentenceChunk, position);
                    position += sentenceChunkTokens;
                    sentenceChunk = sentence;
                } else {
                    sentenceChunk += (sentenceChunk ? ' ' : '') + sentence;
                }
            }
            
            if (sentenceChunk) {
                createChunk(sentenceChunk, position);
                position += estimateTokenCount(sentenceChunk);
            }
            
            currentChunk = '';
        } 
        // Otherwise, add paragraph to current chunk
        else {
            currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        }
    }
    
    // Create final chunk if there's content left
    if (currentChunk) {
        createChunk(currentChunk, position);
    }
    
    return chunks;
}

/**
 * Extract page markers from text
 * Looks for patterns like "[Page 34]" or similar
 * @param {string} text - Full document text
 * @returns {Array<Object>} - Array of page marker objects with position and page number
 */
function extractPageMarkers(text) {
    const pageMarkers = [];
    
    // Look for common page marker patterns
    // This regex matches patterns like [Page 42], (pg. 42), Page 42, etc.
    const pageRegex = /(?:\[Page\s*(\d+)\]|\(page\s*(\d+)\)|\(pg\.?\s*(\d+)\)|Page\s*(\d+))/gi;
    
    let match;
    while ((match = pageRegex.exec(text)) !== null) {
        // Find the first non-undefined group (the actual page number)
        const pageNum = match[1] || match[2] || match[3] || match[4];
        
        pageMarkers.push({
            position: match.index,
            pageNumber: parseInt(pageNum, 10)
        });
    }
    
    return pageMarkers;
}

/**
 * Find page boundaries for a text span
 * @param {number} startPos - Start position in the text
 * @param {number} endPos - End position in the text
 * @param {Array<Object>} pageMarkers - Array of page marker objects
 * @returns {Object} - Object with startPage and endPage
 */
function findPageBoundaries(startPos, endPos, pageMarkers) {
    let startPage = null;
    let endPage = null;
    
    // Find the page that contains or precedes startPos
    for (let i = 0; i < pageMarkers.length; i++) {
        if (pageMarkers[i].position <= startPos) {
            startPage = pageMarkers[i].pageNumber;
        } else {
            break;
        }
    }
    
    // Find the page that contains or precedes endPos
    for (let i = 0; i < pageMarkers.length; i++) {
        if (pageMarkers[i].position <= endPos) {
            endPage = pageMarkers[i].pageNumber;
        } else {
            break;
        }
    }
    
    return { startPage, endPage };
}

/**
 * Extracts the table of contents from the PDF text if available
 * @param {string} text - Full document text
 * @returns {Array<Object>|null} - Array of TOC entries or null if not found
 */
function extractTableOfContents(text) {
    // Look for common TOC patterns
    const tocHeaders = [
        "TABLE OF CONTENTS",
        "CONTENTS",
        "Table of Contents"
    ];
    
    // Try to find the start of the TOC
    let tocStart = -1;
    for (const header of tocHeaders) {
        const index = text.indexOf(header);
        if (index !== -1) {
            tocStart = index + header.length;
            break;
        }
    }
    
    if (tocStart === -1) return null;
    
    // Look for the end of the TOC - usually before the first chapter
    // This is an approximation - could be improved
    const commonChapterStarts = [
        "\nCHAPTER 1",
        "\nChapter 1",
        "\nINTRODUCTION",
        "\nPREFACE"
    ];
    
    let tocEnd = text.length;
    for (const chapterStart of commonChapterStarts) {
        const index = text.indexOf(chapterStart, tocStart);
        if (index !== -1 && index < tocEnd) {
            tocEnd = index;
        }
    }
    
    // Extract TOC text
    const tocText = text.slice(tocStart, tocEnd).trim();
    
    // Parse TOC entries
    // This regex looks for lines with a title possibly followed by a page number
    const tocEntryRegex = /^(.*?)(?:\.{2,}|\s{3,}|…+)\s*(\d+)$/gm;
    const tocEntries = [];
    
    let entryMatch;
    while ((entryMatch = tocEntryRegex.exec(tocText)) !== null) {
        tocEntries.push({
            title: entryMatch[1].trim(),
            page: parseInt(entryMatch[2], 10)
        });
    }
    
    return tocEntries.length > 0 ? tocEntries : null;
}

module.exports = {
    chunkText,
    estimateTokenCount,
    extractPageMarkers,
    findPageBoundaries,
    extractTableOfContents
}; 