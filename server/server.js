const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const logger = require('./logger'); // Import the logger
require('dotenv').config();

// Import our new services
const bookService = require('./services/bookService');
const { TextChunk, ChunkAnalysis, BookAnalysis } = require('./models');
const { chunkText, extractTableOfContents } = require('./utils/textProcessor');

const app = express();
const PORT = process.env.PORT || 5001;
const DOCS_DIR = path.resolve(__dirname, '../public/docs');

// Find first available PDF in docs folder
const findFirstPdf = () => {
  try {
    const files = fs.readdirSync(DOCS_DIR);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    if (pdfFiles.length === 0) {
      throw new Error('No PDF files found in the docs directory');
    }
    
    return path.join('../public/docs', pdfFiles[0]);
  } catch (error) {
    console.error('Error finding PDF files:', error);
    throw error;
  }
};

// Default PDF path - will be set during initialization
let PDF_PATH = '';
const OLLAMA_API_URL = 'http://localhost:11434/api/generate';

// Middleware
app.use(cors());
app.use(express.json());

// Store PDF content in memory
let pdfText = '';
let currentPdfName = '';
let pdfTitle = '';

// Extract the title from PDF content
const extractPdfTitle = (text, filename = currentPdfName) => {
  // Get the first few pages worth of content for analysis
  const firstPageLines = text.split('\n').slice(0, 100).filter(line => line.trim() !== '');
  let candidates = [];
  
  // Look for likely title patterns
  for (let i = 0; i < Math.min(firstPageLines.length, 30); i++) {
    const line = firstPageLines[i].trim();
    
    // Skip obvious non-titles
    if (!line || 
        line.length < 3 || 
        line.length > 120 ||
        line.startsWith('http') ||
        line.startsWith('www.') ||
        line.includes('@') ||
        line.includes('©') ||
        line.includes('copyright') ||
        line.includes('all rights reserved') ||
        line.match(/^\d+(\.\d+)*$/) ||  // Just numbers/versions
        line.match(/^(page|chapter|section)\s+\d+$/i)) { // Page numbers or chapter headers
      continue;
    }
    
    let score = 0;
    
    // Prioritize lines that appear like titles
    if (line === line.toUpperCase() && line.length > 5) {
      score += 10; // All caps is often a title in PDFs
    }
    
    if (line.match(/^[A-Z][^.!?]*$/) && line.length > 10) {
      score += 5; // Starts with capital, no ending punctuation, good length
    }
    
    // Title-like phrases
    if (line.match(/^the\s+[a-z]+/i) || 
        line.match(/^[a-z]+\s+of\s+[a-z]+/i) ||
        line.match(/^[a-z]+\s+and\s+[a-z]+/i)) {
      score += 3;
    }
    
    // Position bonus - titles usually appear early
    score += Math.max(0, 10 - i);
    
    // Add to candidates with score
    candidates.push({ text: line, score, position: i });
  }
  
  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score);
  
  // Try to find specific title patterns if we have enough candidates
  if (candidates.length > 0) {
    // Look for "TITLE" pattern (all caps prominent text)
    const allCapsTitle = candidates.find(c => 
      c.text === c.text.toUpperCase() && 
      c.text.length > 5 &&
      c.text.length < 80 &&
      !/^\d+/.test(c.text) // Not starting with numbers
    );
    
    if (allCapsTitle) {
      console.log(`Found likely title (all caps): "${allCapsTitle.text}"`);
      return allCapsTitle.text;
    }
    
    // Return the highest scoring candidate
    if (candidates[0].score > 5) {
      console.log(`Found likely title (highest score ${candidates[0].score}): "${candidates[0].text}"`);
      return candidates[0].text;
    }
  }
  
  // Extended search - look for specific title keywords in the first 200 lines
  const extendedLines = text.split('\n').slice(0, 200).filter(line => line.trim() !== '');
  for (const line of extendedLines) {
    const trimmed = line.trim();
    if ((trimmed.toLowerCase().includes('title:') || 
         trimmed.match(/^title\s*[:-]/i)) && 
        trimmed.length < 100) {
      const titleParts = trimmed.split(/:\s*/);
      if (titleParts.length > 1) {
        const extractedTitle = titleParts[1].trim();
        console.log(`Found explicit title marker: "${extractedTitle}"`);
        return extractedTitle;
      }
    }
  }
  
  // If all else fails, use filename without extension
  const fallbackTitle = path.basename(filename, '.pdf')
    .replace(/-/g, ' ')
    .replace(/_/g, ' ');
  
  console.log(`No clear title found, using filename: "${fallbackTitle}"`);
  return fallbackTitle;
};

// Load and parse PDF file
const loadPdf = async (pdfPath) => {
  return new Promise((resolve, reject) => {
    const fullPath = path.resolve(__dirname, pdfPath);
    // This requires 'pdftotext' to be installed on your system (part of poppler-utils)
    exec(`pdftotext "${fullPath}" -`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text: ${error}`);
        reject(error);
        return;
      }
      currentPdfName = path.basename(pdfPath);
      pdfText = stdout;
      pdfTitle = extractPdfTitle(stdout);
      
      console.log(`PDF loaded successfully: ${currentPdfName}`);
      console.log(`PDF text length: ${pdfText.length} characters`);
      console.log(`PDF title detected: ${pdfTitle}`);
      
      // Also load the book into the book analysis system
      const bookId = currentPdfName;
      const fullBookPath = fullPath;
      
      // Asynchronously process the book for analysis
      bookService.loadAndProcessBook(fullBookPath, bookId)
        .then(result => {
          console.log(`Book processing result: ${result.message}`);
        })
        .catch(err => {
          console.error(`Error processing book for analysis: ${err.message}`);
        });
      
      resolve(stdout);
    });
  });
};

// Process model response to remove thinking parts
function extractFinalAnswer(text) {
  // Remove content between <think> and </think> tags
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Extract titles for each PDF without loading the full content
const extractTitleForBook = async (filename) => {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(DOCS_DIR, filename);
    
    // Extract just the first few pages to find the title (faster than full book)
    exec(`pdftotext -f 1 -l 3 "${fullPath}" -`, async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error extracting text for title: ${error}`);
        // Don't reject, just return the filename as fallback
        resolve({
          name: filename,
          title: path.basename(filename, '.pdf').replace(/-/g, ' ').replace(/_/g, ' ')
        });
        return;
      }
      
      // Use the same title extraction logic
      const title = extractPdfTitle(stdout, filename);
      resolve({
        name: filename,
        title: title
      });
    });
  });
};

// Endpoint to list available PDFs
app.get('/api/books', async (req, res) => {
  try {
    console.log("GET /api/books called");
    const files = fs.readdirSync(DOCS_DIR);
    console.log("Files in DOCS_DIR:", files);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    console.log("PDF files found:", pdfFiles);
    
    // Get titles for all books (in parallel)
    const bookPromises = pdfFiles.map(async file => {
      // For the current book, use the cached title
      if (file === currentPdfName) {
        return {
          name: file,
          path: `/docs/${file}`,
          current: true,
          title: pdfTitle
        };
      }
      
      // For other books, extract title
      try {
        const bookInfo = await extractTitleForBook(file);
        return {
          name: file,
          path: `/docs/${file}`,
          current: false,
          title: bookInfo.title
        };
      } catch (error) {
        console.error(`Error extracting title for ${file}:`, error);
        return {
          name: file,
          path: `/docs/${file}`,
          current: false,
          title: file.replace('.pdf', '').replace(/-/g, ' ').replace(/_/g, ' ')
        };
      }
    });
    
    const books = await Promise.all(bookPromises);
    console.log("Sending books response:", books);
    
    res.json({ books });
  } catch (error) {
    console.error('Error listing PDF files:', error);
    res.status(500).json({ error: 'Failed to list PDF files' });
  }
});

// Endpoint to change the current PDF
app.post('/api/books/change', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }
    
    // Check if file exists
    const fullPath = path.join(DOCS_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Load the new PDF
    await loadPdf(`../public/docs/${filename}`);
    
    res.json({ 
      success: true, 
      message: `Successfully changed to "${filename}"`,
      book: {
        name: filename,
        path: `/docs/${filename}`,
        current: true,
        title: pdfTitle
      }
    });
  } catch (error) {
    console.error('Error changing PDF:', error);
    res.status(500).json({ error: 'Failed to change PDF' });
  }
});

// Chat endpoint
app.get('/api/chat', async (req, res) => {
  try {
    const { question } = req.query;
    
    if (!question) {
      throw new Error('Question is required');
    }
    
    if (!pdfText) {
      throw new Error('No book is currently loaded. Please select a book first.');
    }
    
    // Get the book analysis if available
    const bookAnalysis = bookService.getAnalysisResults(currentPdfName);
    const hasAnalysis = bookAnalysis && bookAnalysis.status === 'completed';
    
    logger.info(`Chat question received: "${question}"`);
    
    // Create a context for the LLM that includes analysis results
    let prompt = `\nYou are an AI assistant engaging in a conversation about a PDF document titled "${pdfTitle}". \nIf you need to think through your answer, place your thinking inside <think> </think> tags.\nThis thinking will be hidden from the user, so make sure your final answer outside these tags is complete.\n\nIMPORTANT: You have a memory of our conversation. Refer to it when relevant and don't repeat information unnecessarily.\n\nFORMAT YOUR RESPONSE USING MARKDOWN:\n- Use **bold** for emphasis\n- Use *italics* for subtle emphasis\n- Use ## headings to organize longer answers\n- Use numbered lists (1. 2. 3.) for steps or sequences\n- Use bullet points for lists of items\n- Use \`code\` for technical terms\n- Use \`\`\`code blocks\`\`\` for examples\n- Use > for quoting text from the document\n\n`;
    
    // Add the full text of the book
    prompt += `Here's the full content of the document "${pdfTitle}":\n\n${pdfText}\n\n`;
    
    // Add current question
    prompt += `Human: ${question}\n\n`;
    
    // Set up SSE for streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // We need to collect the full response for logging
    let fullResponse = '';
    
    // Make the request to Ollama with streaming enabled
    try {
      const response = await axios.post(OLLAMA_API_URL, {
        model: "deepseek-r1:7b",
        prompt: prompt,
        stream: true
      }, {
        responseType: 'stream',
        timeout: 30000 // 30 second timeout
      });
      
      // Process the streaming response
      let buffer = '';
      let fullResponseBuffer = '';
      let isThinking = false;
      
      response.data.on('data', (chunk) => {
        try {
          // Add new chunk to buffer
          buffer += chunk.toString();
          
          // Process complete JSON objects
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            // Extract a complete line
            const line = buffer.substring(0, newlineIndex).trim();
            buffer = buffer.substring(newlineIndex + 1);
            
            // Skip empty lines
            if (!line) continue;
            
            try {
              const data = JSON.parse(line);
              
              if (data.response) {
                fullResponseBuffer += data.response;
                
                // Check if we're in a thinking block
                if (fullResponseBuffer.includes('<think>')) {
                  isThinking = true;
                }
                
                // If we're in a thinking block, wait until it ends
                if (isThinking) {
                  if (fullResponseBuffer.includes('</think>')) {
                    isThinking = false;
                    // Remove the thinking block
                    fullResponseBuffer = fullResponseBuffer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                  }
                } else {
                  // If we're not in a thinking block, stream the response
                  const chunk = fullResponseBuffer;
                  fullResponseBuffer = '';
                  fullResponse += chunk;
                  res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                }
                
                // If this is the final chunk, also send the 'done' event
                if (data.done) {
                  // Make sure to send any remaining non-thinking content
                  if (fullResponseBuffer) {
                    const finalChunk = fullResponseBuffer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    if (finalChunk) {
                      fullResponse += finalChunk;
                      res.write(`data: ${JSON.stringify({ chunk: finalChunk })}\n\n`);
                    }
                  }
                  
                  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                  
                  // Log the full response once completed
                  logger.llm('Chat (Streaming)', fullResponse);
                  
                  // End the response
                  res.end();
                }
              }
            } catch (parseError) {
              console.error('Error parsing JSON:', parseError);
              // Don't end the response here, just skip this chunk
              continue;
            }
          }
        } catch (chunkError) {
          console.error('Error processing chunk:', chunkError);
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: 'Error processing response chunk' })}\n\n`);
            res.end();
          }
        }
      });
      
      // Handle errors in the stream
      response.data.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: 'Stream error occurred' })}\n\n`);
          res.end();
        }
      });
      
      // Handle end of stream
      response.data.on('end', () => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
        }
      });
      
    } catch (error) {
      console.error('Error in streaming request:', error);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: `Failed to get response: ${error.message}` })}\n\n`);
        res.end();
      }
    }
    
  } catch (error) {
    console.error('Error in chat:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate response', details: error.message });
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// NEW API ENDPOINTS FOR BOOK ANALYSIS

// Start book analysis
app.post('/api/books/:bookId/analyze', async (req, res) => {
  try {
    const { bookId } = req.params;
    const options = req.body.options || {};
    
    // Set a timeout to respond while analysis continues in background
    const analysisPromise = bookService.analyzeBook(bookId, options);
    
    // Return status immediately
    res.json({
      success: true,
      message: `Analysis for book ${bookId} started`,
      bookId,
      status: 'started'
    });
    
    // Continue with analysis without blocking the response
    await analysisPromise;
    
  } catch (error) {
    console.error(`Error starting analysis for book ${req.params.bookId}:`, error);
    res.status(500).json({ 
      success: false,
      error: `Failed to start analysis: ${error.message}` 
    });
  }
});

// Get analysis status or results
app.get('/api/books/:bookId/analysis', (req, res) => {
  try {
    const { bookId } = req.params;
    const results = bookService.getAnalysisResults(bookId);
    
    if (!results.success && results.status === 'not_found') {
      return res.status(404).json(results);
    }
    
    res.json(results);
  } catch (error) {
    console.error(`Error getting analysis results for book ${req.params.bookId}:`, error);
    res.status(500).json({ 
      success: false,
      error: `Failed to get analysis results: ${error.message}` 
    });
  }
});

// Get book structure
app.get('/api/books/:bookId/structure', async (req, res) => {
  try {
    const { bookId } = req.params;
    const results = bookService.getAnalysisResults(bookId);
    
    if (!results.success && results.status === 'not_found') {
      return res.status(404).json({
        success: false,
        message: `Book ${bookId} not found`,
        status: 'not_found'
      });
    }
    
    // If analysis is not complete, return what we have
    const structure = {
      bookInfo: results.bookInfo || { title: bookId },
      analysisStatus: results.status,
      structure: results.analysis && results.analysis.structure ? results.analysis.structure : null,
      tableOfContents: results.bookInfo && results.bookInfo.tableOfContents ? results.bookInfo.tableOfContents : null
    };
    
    // If we have a complete analysis, include details
    if (results.status === 'completed') {
      structure.plotSummary = results.analysis && results.analysis.plotSummary ? results.analysis.plotSummary : null;
      structure.mainCharacters = results.analysis && results.analysis.mainCharacters ? results.analysis.mainCharacters : null;
      structure.themes = results.analysis && results.analysis.themes ? results.analysis.themes : null;
    }
    
    res.json({
      success: true,
      structure
    });
  } catch (error) {
    console.error(`Error getting book structure for ${req.params.bookId}:`, error);
    res.status(500).json({ 
      success: false,
      error: `Failed to get book structure: ${error.message}` 
    });
  }
});

// UPDATE ENDPOINT FOR LOGS
app.get('/api/logs', (req, res) => {
  const { limit = 20, type } = req.query;
  
  // Use the recentLogs from the logger module
  let filteredLogs = logger.getRecentLogs();
  if (type) {
    filteredLogs = filteredLogs.filter(log => log.type === type.toUpperCase());
  }
  
  // Return most recent logs, limited by the requested amount
  res.json({
    logs: filteredLogs.slice(-Math.min(parseInt(limit), 100))
  });
});

// Start server
app.listen(PORT, async () => {
  try {
    console.log(`Starting server on port ${PORT}...`);
    // Find and load the first available PDF
    console.log(`Looking for PDFs in ${DOCS_DIR}...`);
    PDF_PATH = findFirstPdf();
    console.log(`Found PDF: ${PDF_PATH}`);
    await loadPdf(PDF_PATH);
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Failed to start server properly:', error);
  }
}).on('error', (error) => {
  console.error('Server failed to start:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please use a different port.`);
  }
}); 