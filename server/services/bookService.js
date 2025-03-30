/**
 * Book service for the AI-Media Literary Analysis System
 * Manages book data and coordinates the analysis process
 */

const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { TextChunk, BookAnalysis } = require('../models');
const { chunkText, extractTableOfContents, estimateTokens } = require('../utils/textProcessor');
const analysisService = require('./analysisService');
const synthesisService = require('./synthesisService');
const logger = require('../logger'); // Import logger

// Convert exec to Promise
const execPromise = util.promisify(exec);

// In-memory store for book analyses
const bookAnalysesMap = new Map();

/**
 * Extract text from a PDF file
 * @param {string} pdfPath - Path to the PDF file 
 * @returns {Promise<string>} - The extracted text
 */
async function extractPdfText(pdfPath) {
    return new Promise((resolve, reject) => {
        // This requires 'pdftotext' to be installed (part of poppler-utils)
        exec(`pdftotext "${pdfPath}" -`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error extracting PDF text: ${error}`);
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

/**
 * Extract basic metadata from a PDF
 * @param {string} pdfPath - Path to the PDF file
 * @returns {Promise<Object>} - Metadata object
 */
async function extractPdfMetadata(pdfPath) {
    try {
        // Use pdfinfo to extract metadata (part of poppler-utils)
        const { stdout } = await execPromise(`pdfinfo "${pdfPath}"`);
        
        // Parse the output
        const metadata = {};
        const lines = stdout.split('\n');
        
        for (const line of lines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.slice(0, colonIndex).trim();
                const value = line.slice(colonIndex + 1).trim();
                
                // Convert some keys to proper format
                const normalizedKey = key.toLowerCase()
                    .replace(/\s+/g, '_')
                    .replace(/[^a-z0-9_]/g, '');
                
                metadata[normalizedKey] = value;
            }
        }
        
        return metadata;
    } catch (error) {
        console.error(`Error extracting PDF metadata: ${error}`);
        return {};
    }
}

/**
 * Get or create book analysis
 * @param {string} bookId - Book identifier (typically filename)
 * @returns {BookAnalysis|null} - Book analysis object or null if not found
 */
function getBookAnalysis(bookId) {
    return bookAnalysesMap.get(bookId) || null;
}

/**
 * Load and process a book for analysis
 * @param {string} pdfPath - Full path to the PDF file
 * @param {string} bookId - Book identifier (typically filename)
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} - Processing result information
 */
async function loadAndProcessBook(pdfPath, bookId, options = {}) {
    try {
        // Check if we already have an analysis for this book
        if (bookAnalysesMap.has(bookId) && !options.force) {
            return {
                success: true,
                message: `Book ${bookId} already processed`,
                bookId,
                status: 'exists',
                bookInfo: bookAnalysesMap.get(bookId).bookInfo
            };
        }
        
        console.log(`Processing book: ${bookId}`);
        
        // 1. Extract text from PDF
        console.log('Extracting text...');
        const text = await extractPdfText(pdfPath);
        
        // 2. Extract metadata
        console.log('Extracting metadata...');
        const metadata = await extractPdfMetadata(pdfPath);
        
        // 3. Extract table of contents if available
        console.log('Extracting table of contents...');
        const toc = extractTableOfContents(text);
        
        // 4. Create book info object
        const bookInfo = {
            id: bookId,
            title: metadata.title || path.basename(pdfPath, '.pdf').replace(/-/g, ' ').replace(/_/g, ' '),
            author: metadata.author || 'Unknown',
            path: pdfPath,
            pageCount: metadata.pages ? parseInt(metadata.pages, 10) : null,
            metadata,
            tableOfContents: toc
        };
        
        // 5. Chunk the text
        console.log('Chunking text...');
        const chunks = chunkText(text, options.chunking || {});
        console.log(`Created ${chunks.length} chunks`);
        
        // 6. Create a new book analysis object
        const bookAnalysis = new BookAnalysis(bookInfo);
        bookAnalysis.chunks = chunks;
        bookAnalysis.analysisStatus.totalChunks = chunks.length;
        
        // 7. Store in memory
        bookAnalysesMap.set(bookId, bookAnalysis);
        
        return {
            success: true,
            message: `Successfully processed book ${bookId}`,
            bookId,
            status: 'processed',
            bookInfo,
            chunkCount: chunks.length
        };
    } catch (error) {
        console.error(`Error processing book ${bookId}:`, error);
        return {
            success: false,
            message: `Failed to process book ${bookId}: ${error.message}`,
            bookId,
            status: 'error',
            error: error.message
        };
    }
}

/**
 * Analyze a book that has been loaded into memory
 * @param {string} bookId - The book identifier 
 * @param {Object} options - Analysis options
 * @returns {Promise<Object>} - Analysis result
 */
async function analyzeBook(bookId, options = {}) {
    // Get the book analysis from the map
    const bookAnalysis = bookAnalysesMap.get(bookId);
    if (!bookAnalysis) {
        throw new Error(`Book ${bookId} not found or not loaded`);
    }
    
    logger.info(`Starting analysis for book: ${bookId}`);
    
    // Reset analysis status
    bookAnalysis.analysisStatus.status = 'in-progress';
    bookAnalysis.analysisStatus.startTime = new Date().toISOString();
    bookAnalysis.analysisStatus.chunksAnalyzed = 0;
    bookAnalysis.analysisStatus.error = null;
    
    try {
        // 1. Analyze each chunk
        logger.info(`Analyzing ${bookAnalysis.chunks.length} text chunks...`);
        
        const progressCallback = (progress) => {
            bookAnalysis.analysisStatus.chunksAnalyzed = progress.current;
            const percentComplete = Math.round((progress.current / progress.total) * 100);
            logger.info(`Analysis progress: ${progress.current}/${progress.total} chunks (${percentComplete}%)`);
        };
        
        const chunkAnalyses = await analysisService.analyzeChunks(bookAnalysis.chunks, progressCallback);
        
        // Attach analyses to chunks
        chunkAnalyses.forEach((analysis, index) => {
            bookAnalysis.chunks[index].analysis = analysis;
        });
        
        // 2. Synthesize results
        logger.info('Synthesizing analysis results...');
        const synthesizedAnalysis = await synthesisService.synthesizeBookAnalysis(
            bookAnalysis.chunks,
            bookAnalysis.bookInfo
        );
        
        // Update the book analysis with synthesized results
        bookAnalysis.globalAnalysis = synthesizedAnalysis.globalAnalysis;
        bookAnalysis.analysisStatus.status = 'completed';
        bookAnalysis.analysisStatus.endTime = new Date().toISOString();
        
        logger.info(`Analysis completed for book: ${bookId}`);
        
        return {
            success: true,
            message: 'Analysis completed successfully',
            bookId
        };
    } catch (error) {
        logger.error(`Error analyzing book ${bookId}: ${error.message}`);
        
        // Update analysis status
        bookAnalysis.analysisStatus.status = 'failed';
        bookAnalysis.analysisStatus.error = error.message;
        
        throw error;
    }
}

/**
 * Get analysis results for a book
 * @param {string} bookId - Book identifier
 * @returns {Object} - Analysis results or status
 */
function getAnalysisResults(bookId) {
    const bookAnalysis = bookAnalysesMap.get(bookId);
    if (!bookAnalysis) {
        return {
            success: false,
            message: `Book ${bookId} not found`,
            status: 'not_found'
        };
    }
    
    const status = bookAnalysis.analysisStatus.status;
    
    // If analysis is still in progress, return status
    if (status === 'in-progress' || status === 'pending') {
        return {
            success: true,
            message: `Analysis for book ${bookId} is ${status}`,
            bookId,
            status,
            progress: {
                current: bookAnalysis.analysisStatus.chunksAnalyzed,
                total: bookAnalysis.analysisStatus.totalChunks,
                percentage: Math.round((bookAnalysis.analysisStatus.chunksAnalyzed / bookAnalysis.analysisStatus.totalChunks) * 100)
            }
        };
    }
    
    // If analysis failed, return error
    if (status === 'failed') {
        return {
            success: false,
            message: `Analysis for book ${bookId} failed: ${bookAnalysis.analysisStatus.error}`,
            bookId,
            status,
            error: bookAnalysis.analysisStatus.error
        };
    }
    
    // If analysis is completed, return results
    return {
        success: true,
        message: `Analysis for book ${bookId} completed`,
        bookId,
        status,
        bookInfo: bookAnalysis.bookInfo,
        analysis: bookAnalysis.globalAnalysis,
        stats: {
            chunksAnalyzed: bookAnalysis.analysisStatus.chunksAnalyzed,
            totalChunks: bookAnalysis.analysisStatus.totalChunks,
            startTime: bookAnalysis.analysisStatus.startTime,
            endTime: bookAnalysis.analysisStatus.endTime
        }
    };
}

module.exports = {
    extractPdfText,
    loadAndProcessBook,
    analyzeBook,
    getBookAnalysis,
    getAnalysisResults
}; 